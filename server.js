// 1. Importação de Módulos
const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const archiver = require('archiver');
const { SpeechClient } = require('@google-cloud/speech');

// 2. Configuração Inicial
const app = express();
const PORT = process.env.PORT || 10000;

const uploadDir = path.join(__dirname, 'uploads');
const processedDir = path.join(__dirname, 'processed');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir);

// 3. Middlewares com CORS liberado
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use('/downloads', express.static(processedDir));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}-${safeOriginalName}`);
    }
});

const upload = multer({ storage, limits: { fieldSize: 50 * 1024 * 1024 } });

// 4. Funções Auxiliares
function runFFmpeg(command, options = {}) {
    return new Promise((resolve, reject) => {
        exec(command, options, (error, stdout, stderr) => {
            if (error) return reject(stderr || error.message);
            resolve(stdout);
        });
    });
}

function getMediaDuration(filePath) {
    return new Promise((resolve, reject) => {
        const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
        exec(command, (error, stdout, stderr) => {
            if (error) return reject(stderr || error.message);
            resolve(parseFloat(stdout));
        });
    });
}

function sendZip(res, filesToZip) {
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=resultado.zip');
    archive.pipe(res);
    filesToZip.forEach(file => archive.file(file.path, { name: file.name }));
    archive.finalize();
    archive.on('end', () => {
        filesToZip.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
    });
}

// 5. Rotas básicas
app.get('/', (req, res) => res.send('Backend DarkMaker está a funcionar!'));
app.get('/status', (req, res) => res.status(200).send('Servidor pronto.'));

// 6. Rotas de vídeo (cortar, unir, comprimir, embaralhar, remover áudio)
app.post('/cortar-video', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    const { startTime, endTime } = req.body;
    if (!files.length) return res.status(400).send('Nenhum ficheiro enviado.');
    try {
        const processedFiles = [];
        for (const file of files) {
            const outputFilename = `cortado-${file.filename}`;
            const outputPath = path.join(processedDir, outputFilename);
            await runFFmpeg(`ffmpeg -i "${file.path}" -ss ${startTime} -to ${endTime} -c copy "${outputPath}"`);
            processedFiles.push({ path: outputPath, name: outputFilename });
            fs.unlinkSync(file.path);
        }
        sendZip(res, processedFiles);
    } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/unir-videos', upload.array('videos'), async (req,res)=>{
    const files = req.files || [];
    if(files.length<2) return res.status(400).send('Mínimo 2 vídeos.');
    const fileListPath = path.join(uploadDir, `list-${Date.now()}.txt`);
    const outputPath = path.join(processedDir, `unido-${Date.now()}.mp4`);
    fs.writeFileSync(fileListPath, files.map(f=>`file '${f.path.replace(/'/g,"'\\''")}'`).join('\n'));
    try{
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy "${outputPath}"`);
        sendZip(res, [{path: outputPath,name:path.basename(outputPath)}]);
    }catch(e){ res.status(500).send(e.toString()); }
});

app.post('/comprimir-videos', upload.array('videos'), async (req,res)=>{
    const files = req.files || [];
    if(!files.length) return res.status(400).send('Nenhum ficheiro enviado.');
    const crfMap = { alta:'18', media:'23', baixa:'28' };
    const crf = crfMap[req.body.quality];
    if(!crf) return res.status(400).send('Qualidade inválida.');
    try{
        const processedFiles = [];
        for(const file of files){
            const outputPath = path.join(processedDir, `comprimido-${file.filename}`);
            await runFFmpeg(`ffmpeg -i "${file.path}" -vcodec libx264 -crf ${crf} "${outputPath}"`);
            processedFiles.push({path:outputPath,name:path.basename(outputPath)});
            fs.unlinkSync(file.path);
        }
        sendZip(res, processedFiles);
    }catch(e){ res.status(500).send(e.toString()); }
});

app.post('/embaralhar-videos', upload.array('videos'), async (req,res)=>{
    const files = req.files || [];
    if(files.length<2) return res.status(400).send('Mínimo 2 vídeos.');
    const shuffled = files.sort(()=>Math.random()-0.5);
    const fileListPath = path.join(uploadDir, `list-${Date.now()}.txt`);
    const outputPath = path.join(processedDir, `embaralhado-${Date.now()}.mp4`);
    fs.writeFileSync(fileListPath, shuffled.map(f=>`file '${f.path.replace(/'/g,"'\\''")}'`).join('\n'));
    try{
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy "${outputPath}"`);
        sendZip(res, [{path: outputPath,name:path.basename(outputPath)}]);
    }catch(e){ res.status(500).send(e.toString()); }
});

app.post('/remover-audio', upload.array('videos'), async (req,res)=>{
    const files = req.files || [];
    if(!files.length) return res.status(400).send('Nenhum ficheiro enviado.');
    try{
        const processedFiles = [];
        for(const file of files){
            const outputPath = path.join(processedDir, `processado-${file.filename}`);
            const flags = req.body.removeAudio==='true' ? '-c:v copy -an' : '-c:v copy -c:a copy';
            await runFFmpeg(`ffmpeg -i "${file.path}" ${flags} "${outputPath}"`);
            processedFiles.push({path:outputPath,name:path.basename(outputPath)});
            fs.unlinkSync(file.path);
        }
        sendZip(res, processedFiles);
    }catch(e){ res.status(500).send(e.toString()); }
});

// 7. Rotas IA Turbo (extrair áudio, transcrever, extrair frames)
app.post('/extrair-audio', upload.single('video'), async (req,res)=>{
    try{
        const input = req.file.path;
        const outputPath = path.join(processedDir, `audio-${Date.now()}.wav`);
        await runFFmpeg(`ffmpeg -i "${input}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${outputPath}"`);
        res.sendFile(outputPath,()=>fs.unlinkSync(input));
    }catch(e){ res.status(500).send(e.toString()); }
});

app.post('/transcrever-audio', upload.fields([{name:'audio',maxCount:1}]), async (req,res)=>{
    try{
        const audioFile = req.files.audio[0].path;
        // Aqui você pode usar a lógica do Google Speech ou Whisper
        res.json({script:`Transcrição simulada de ${audioFile}`});
    }catch(e){ res.status(500).send(e.toString()); }
});

app.post('/extrair-frames', upload.single('video'), async (req,res)=>{
    try{
        const input = req.file.path;
        const outputPattern = path.join(processedDir, `frame-${Date.now()}-%03d.png`);
        await runFFmpeg(`ffmpeg -i "${input}" -vf fps=1 "${outputPattern}"`);
        const files = fs.readdirSync(processedDir).filter(f=>f.includes('frame-')).map(f=>path.join(processedDir,f));
        const base64Frames = files.map(f=>`data:image/png;base64,${fs.readFileSync(f).toString('base64')}`);
        res.json({frames:base64Frames});
        fs.unlinkSync(input);
    }catch(e){ res.status(500).send(e.toString()); }
});

// 8. Criar vídeo automático avançado
app.post('/criar-video-automatico', upload.fields([{name:'narration',maxCount:1},{name:'media',maxCount:50}]), async (req,res)=>{
    try{
        const narrationPath = req.files.narration[0].path;
        const mediaFiles = req.files.media.map(f=>f.path);
        const audioDuration = await getMediaDuration(narrationPath);
        const secondsPerImage = Math.ceil(audioDuration/mediaFiles.length);

        const ffmpegInputs = mediaFiles.map(f=>`-loop 1 -t ${secondsPerImage} -i "${f}"`).join(' ');
        const filterConcat = mediaFiles.map((f,i)=>`[${i}:v]`).join('') + `concat=n=${mediaFiles.length}:v=1:a=0[outv]`;
        const outPath = path.join(processedDir, `video-auto-${Date.now()}.mp4`);

        await runFFmpeg(`ffmpeg ${ffmpegInputs} -i "${narrationPath}" -filter_complex "${filterConcat}" -map "[outv]" -map ${mediaFiles.length}:a -c:v libx264 -c:a aac -shortest "${outPath}"`);

        sendZip(res,[{path:outPath,name:path.basename(outPath)}]);
        fs.unlinkSync(narrationPath);
        mediaFiles.forEach(f=>fs.unlinkSync(f));
    }catch(e){ res.status(500).send(e.toString()); }
});

// 9. Mixar vídeo turbo avançado
app.post('/mixar-video-turbo', upload.fields([{name:'narration',maxCount:1},{name:'media',maxCount:50}]), async (req,res)=>{
    try{
        const narrationPath = req.files.narration[0].path;
        const mediaFiles = req.files.media.map(f=>f.path);
        const audioDuration = await getMediaDuration(narrationPath);
        const secondsPerImage = Math.ceil(audioDuration/mediaFiles.length);

        const ffmpegInputs = mediaFiles.map(f=>`-loop 1 -t ${secondsPerImage} -i "${f}"`).join(' ');
        const filterConcat = mediaFiles.map((f,i)=>`[${i}:v]`).join('') + `concat=n=${mediaFiles.length}:v=1:a=0[outv]`;
        const outPath = path.join(processedDir, `mixado-turbo-${Date.now()}.mp4`);

        await runFFmpeg(`ffmpeg ${ffmpegInputs} -i "${narrationPath}" -filter_complex "${filterConcat}" -map "[outv]" -map ${mediaFiles.length}:a -c:v libx264 -c:a aac -shortest "${outPath}"`);

        sendZip(res,[{path:outPath,name:path.basename(outPath)}]);
        fs.unlinkSync(narrationPath);
        mediaFiles.forEach(f=>fs.unlinkSync(f));
    }catch(e){ res.status(500).send(e.toString()); }
});

// 10. Iniciar servidor
app.listen(PORT,()=>console.log(`Servidor rodando em http://localhost:${PORT}`));
