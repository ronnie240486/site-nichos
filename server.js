// 1. Importação de Módulos
const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
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

// 3. Middlewares
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use('/downloads', express.static(processedDir));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}-${safeOriginalName}`);
    }
});
const upload = multer({ storage, limits: { fieldSize: 100 * 1024 * 1024 } });

// 4. Funções Auxiliares
function runFFmpeg(args, options = {}) {
    return new Promise((resolve, reject) => {
        console.log(`Executando FFmpeg: ffmpeg ${args.join(' ')}`);
        const ff = spawn('ffmpeg', args, options);

        ff.stdout.on('data', (data) => console.log(`FFmpeg stdout: ${data.toString()}`));
        ff.stderr.on('data', (data) => console.log(`FFmpeg stderr: ${data.toString()}`));

        ff.on('close', (code) => {
            if (code !== 0) return reject(new Error(`FFmpeg finalizou com código ${code}`));
            resolve();
        });

        ff.on('error', (err) => reject(err));
    });
}

function getMediaDuration(filePath) {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ]);

        let output = '';
        ffprobe.stdout.on('data', (data) => output += data.toString());
        ffprobe.stderr.on('data', (data) => console.log(`FFprobe stderr: ${data.toString()}`));

        ffprobe.on('close', (code) => {
            if (code !== 0) return reject(new Error(`FFprobe finalizou com código ${code}`));
            resolve(parseFloat(output));
        });

        ffprobe.on('error', (err) => reject(err));
    });
}

function cleanFiles(filePaths) {
    filePaths.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
}

function sendZipResponse(res, filesToZip, filesToDelete) {
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=resultado.zip');

    archive.on('error', (err) => { throw err; });
    archive.pipe(res);

    filesToZip.forEach(file => archive.file(file.path, { name: file.name }));
    archive.finalize();

    archive.on('end', () => {
        console.log('Limpando ficheiros temporários...');
        cleanFiles(filesToDelete);
    });
}

// 5. Rotas
app.get('/', (req, res) => res.send('Backend DarkMaker está a funcionar!'));
app.get('/status', (req, res) => res.status(200).send('Servidor pronto.'));

// --- ROTAS DE VÍDEO ---
app.post('/cortar-video', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).send('Nenhum ficheiro enviado.');

    const { startTime, endTime } = req.body;
    const timeRegex = /^(?:[0-9]+(?:\.[0-9]*)?|[0-5]?\d:[0-5]?\d:[0-5]?\d(?:\.\d+)?)$/;

    if (!startTime || !endTime || !timeRegex.test(startTime) || !timeRegex.test(endTime)) {
        cleanFiles(files.map(f => f.path));
        return res.status(400).send('Formato de tempo inválido. Use HH:MM:SS ou segundos.');
    }

    try {
        const processedFiles = [];
        const filesToDelete = [];
        for (const file of files) {
            const inputPath = file.path;
            const outputFilename = `cortado-${file.filename}`;
            const outputPath = path.join(processedDir, outputFilename);

            await runFFmpeg(['-i', inputPath, '-ss', startTime, '-to', endTime, '-c', 'copy', outputPath]);

            processedFiles.push({ path: outputPath, name: outputFilename });
            filesToDelete.push(inputPath, outputPath);
        }
        sendZipResponse(res, processedFiles, filesToDelete);
    } catch (e) {
        cleanFiles(files.map(f => f.path));
        res.status(500).send(e.message);
    }
});

app.post('/unir-videos', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length < 2) return res.status(400).send('Mínimo 2 vídeos.');

    const fileListPath = path.join(uploadDir, `list-${Date.now()}.txt`);
    const outputFilename = `unido-${Date.now()}.mp4`;
    const outputPath = path.join(processedDir, outputFilename);

    const fileContent = files.map(f => `file '${f.path.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(fileListPath, fileContent);

    const filesToDelete = [...files.map(f => f.path), fileListPath, outputPath];

    try {
        await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', fileListPath, '-c', 'copy', outputPath]);
        sendZipResponse(res, [{ path: outputPath, name: outputFilename }], filesToDelete);
    } catch (e) {
        cleanFiles(filesToDelete);
        res.status(500).send(e.message);
    }
});

app.post('/comprimir-videos', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).send('Nenhum ficheiro enviado.');

    const quality = req.body.quality;
    const crfMap = { alta: '18', media: '23', baixa: '28' };
    const crf = crfMap[quality];
    if (!crf) { cleanFiles(files.map(f => f.path)); return res.status(400).send('Qualidade inválida. Use "alta", "media" ou "baixa".'); }

    try {
        const processedFiles = [];
        const filesToDelete = [];
        for (const file of files) {
            const inputPath = file.path;
            const outputFilename = `comprimido-${file.filename}`;
            const outputPath = path.join(processedDir, outputFilename);

            await runFFmpeg(['-i', inputPath, '-vcodec', 'libx264', '-crf', crf, outputPath]);
            processedFiles.push({ path: outputPath, name: outputFilename });
            filesToDelete.push(inputPath, outputPath);
        }
        sendZipResponse(res, processedFiles, filesToDelete);
    } catch (e) { cleanFiles(files.map(f => f.path)); res.status(500).send(e.message); }
});

app.post('/embaralhar-videos', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length < 2) return res.status(400).send('Mínimo 2 vídeos.');

    const shuffled = files.sort(() => Math.random() - 0.5);
    const fileListPath = path.join(uploadDir, `list-shuf-${Date.now()}.txt`);
    const outputFilename = `embaralhado-${Date.now()}.mp4`;
    const outputPath = path.join(processedDir, outputFilename);

    const fileContent = shuffled.map(f => `file '${f.path.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(fileListPath, fileContent);

    const filesToDelete = [...files.map(f => f.path), fileListPath, outputPath];

    try { await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', fileListPath, '-c', 'copy', outputPath]); sendZipResponse(res, [{ path: outputPath, name: outputFilename }], filesToDelete); }
    catch (e) { cleanFiles(filesToDelete); res.status(500).send(e.message); }
});

app.post('/remover-audio', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).send('Nenhum ficheiro enviado.');
    if (req.body.removeAudio !== 'true' && req.body.removeMetadata !== 'true') return res.status(400).send('Nenhuma opção selecionada.');

    try {
        const processedFiles = [];
        const filesToDelete = [];
        for (const file of files) {
            const inputPath = file.path;
            const outputFilename = `processado-${file.filename}`;
            const outputPath = path.join(processedDir, outputFilename);

            const flags = [];
            if (req.body.removeAudio === 'true') flags.push('-an'); else flags.push('-c:a', 'copy');
            if (req.body.removeMetadata === 'true') flags.push('-map_metadata', '-1');

            await runFFmpeg(['-i', inputPath, '-c:v', 'copy', ...flags, outputPath]);
            processedFiles.push({ path: outputPath, name: outputFilename });
            filesToDelete.push(inputPath, outputPath);
        }
        sendZipResponse(res, processedFiles, filesToDelete);
    } catch (e) { cleanFiles(files.map(f => f.path)); res.status(500).send(e.message); }
});

// --- ROTAS AUTOMÁTICAS / IA TURBO ---
app.post('/criar-video-automatico', upload.fields([{ name: 'narration', maxCount: 1 }, { name: 'media', maxCount: 50 }]), async (req, res) => {
    const narrationFile = req.files.narration?.[0];
    const mediaFiles = req.files.media || [];
    if (!narrationFile || !mediaFiles.length) return res.status(400).send('Narração e pelo menos um ficheiro de media são obrigatórios.');

    const fileListPath = path.join(uploadDir, `list-auto-${Date.now()}.txt`);
    const silentVideoPath = path.join(processedDir, `silent-${Date.now()}.mp4`);
    const outputFilename = `automatico-${Date.now()}.mp4`;
    const outputPath = path.join(processedDir, outputFilename);
    const filesToDelete = [narrationFile.path, ...mediaFiles.map(f => f.path), fileListPath, silentVideoPath, outputPath];

    try {
        const audioDuration = await getMediaDuration(narrationFile.path);
        const durationPerImage = audioDuration / mediaFiles.length;
        const fileContent = mediaFiles.map(f => `file '${f.path.replace(/'/g, "'\\''")}'\nduration ${durationPerImage}`).join('\n');
        const lastFile = mediaFiles[mediaFiles.length - 1].path.replace(/'/g, "'\\''");
        fs.writeFileSync(fileListPath, `${fileContent}\nfile '${lastFile}'`);

        await runFFmpeg(['-f','concat','-safe','0','-i',fileListPath,'-vf',`scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2`,'-c:v','libx264','-r','25','-y',silentVideoPath]);
        await runFFmpeg(['-i',silentVideoPath,'-i',narrationFile.path,'-c:v','copy','-c:a','aac','-shortest',outputPath]);

        sendZipResponse(res, [{ path: outputPath, name: outputFilename }], filesToDelete);
    } catch (e) { cleanFiles(filesToDelete); res.status(500).send(e.message); }
});

app.post('/mixar-video-turbo', upload.array('videos'), async (req,res)=>{
    const files=req.files||[];
    if(files.length<2) return res.status(400).send('Mínimo 2 vídeos.');
    const outputFilename=`mixado-${Date.now()}.mp4`;
    const outputPath=path.join(processedDir,outputFilename);
    const filesToDelete=[...files.map(f=>f.path),outputPath];

    try{
        const concatListPath=path.join(uploadDir,`list-mix-${Date.now()}.txt`);
        fs.writeFileSync(concatListPath,files.map(f=>`file '${f.path.replace(/'/g,"'\\''")}'`).join('\n'));
        filesToDelete.push(concatListPath);
        await runFFmpeg(['-f','concat','-safe','0','-i',concatListPath,'-c','copy',outputPath]);
        sendZipResponse(res,[{path:outputPath,name:outputFilename}],filesToDelete);
    }catch(e){cleanFiles(filesToDelete);res.status(500).send(e.message);}
});

// --- ROTAS DE ÁUDIO / EXTRAÇÃO ---
app.post('/extrair-audio', upload.array('videos'), async (req,res)=>{
    const files=req.files||[];
    if(!files.length) return res.status(400).send('Nenhum ficheiro enviado.');
    try{
        const processedFiles=[]; const filesToDelete=[];
        for(const file of files){
            const inputPath=file.path;
            const outputFilename=`audio-${file.filename}.wav`;
            const outputPath=path.join(processedDir,outputFilename);
            await runFFmpeg(['-i',inputPath,'-vn','-acodec','pcm_s16le','-ar','16000','-ac','1',outputPath]);
            processedFiles.push({path:outputPath,name:outputFilename});
            filesToDelete.push(inputPath,outputPath);
        }
        sendZipResponse(res,processedFiles,filesToDelete);
    }catch(e){cleanFiles(files.map(f=>f.path));res.status(500).send(e.message);}
});

app.post('/transcrever-audio', upload.array('audios'), async (req,res)=>{
    const files=req.files||[];
    if(!files.length) return res.status(400).send('Nenhum ficheiro enviado.');
    const client=new SpeechClient();
    try{
        const results=[];
        for(const file of files){
            const fileBytes=fs.readFileSync(file.path);
            const audio={content:fileBytes.toString('base64')};
            const config={encoding:'LINEAR16',sampleRateHertz:16000,languageCode:'pt-BR'};
            const request={audio,config};
            const [response]=await client.recognize(request);
            const transcription=response.results.map(r=>r.alternatives[0].transcript).join(' ');
            results.push({file:file.originalname,transcription});
        }
        cleanFiles(files.map(f=>f.path));
        res.json(results);
    }catch(e){cleanFiles(files.map(f=>f.path));res.status(500).send(e.message);}
});

app.post('/extrair-frames', upload.array('videos'), async (req,res)=>{
    const files=req.files||[];
    if(!files.length) return res.status(400).send('Nenhum ficheiro enviado.');
    const frameRate=req.body.frameRate||1;
    try{
        const processedFiles=[];
        const filesToDelete=[];
        for(const file of files){
            const inputPath=file.path;
            const outputFolder=path.join(processedDir,`frames-${Date.now()}-${file.filename}`);
            if(!fs.existsSync(outputFolder)) fs.mkdirSync(outputFolder);
            await runFFmpeg(['-i',inputPath,'-vf',`fps=${frameRate}`,path.join(outputFolder,'frame-%03d.png')]);
            const zipPath=path.join(processedDir,`frames-${file.filename}.zip`);
            const archive=archiver('zip',{zlib:{level:9}});
            const output=fs.createWriteStream(zipPath);
            archive.pipe(output);
            archive.directory(outputFolder,false);
            await archive.finalize();
            processedFiles.push({path:zipPath,name:`frames-${file.filename}.zip`});
            filesToDelete.push(inputPath,zipPath,...fs.readdirSync(outputFolder).map(f=>path.join(outputFolder,f)));
            fs.rmdirSync(outputFolder);
        }
        sendZipResponse(res,processedFiles,filesToDelete);
    }catch(e){cleanFiles(files.map(f=>f.path));res.status(500).send(e.message);}
});

// 6. Iniciar Servidor
app.listen(PORT,()=>console.log(`Servidor DarkMaker a correr na porta ${PORT}`));
