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

// 3. Middlewares
app.use(cors({ origin: '*' })); // permite qualquer frontend
app.use(express.json({ limit: '50mb' }));
app.use('/downloads', express.static(processedDir));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}-${safeOriginalName}`);
    }
});
const upload = multer({ storage: storage, limits: { fieldSize: 50 * 1024 * 1024 } });

// 4. Funções Auxiliares
function runFFmpeg(command, options = {}) {
    return new Promise((resolve, reject) => {
        console.log(`Executando FFmpeg: ${command}`);
        exec(command, options, (error, stdout, stderr) => {
            if (error) {
                console.error(`FFmpeg Stderr: ${stderr}`);
                return reject(new Error(`Erro no FFmpeg: ${stderr || 'Erro desconhecido'}`));
            }
            console.log(`FFmpeg Stdout: ${stdout}`);
            resolve();
        });
    });
}

function getMediaDuration(filePath) {
    return new Promise((resolve, reject) => {
        const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`FFprobe Stderr: ${stderr}`);
                return reject(new Error(`Erro no ffprobe: ${stderr}`));
            }
            resolve(parseFloat(stdout));
        });
    });
}

function sendZipResponse(res, filesToZip, filesToDelete) {
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=resultado.zip');
    res.on('close', () => {
        filesToDelete.forEach(file => { if (fs.existsSync(file)) fs.unlinkSync(file); });
    });
    archive.on('error', (err) => { throw err; });
    archive.pipe(res);
    filesToZip.forEach(file => {
        archive.file(file.path, { name: file.name });
    });
    archive.finalize();
}

// 5. Rotas Básicas
app.get('/', (req, res) => res.send('Backend DarkMaker está a funcionar!'));
app.get('/status', (req, res) => res.status(200).send('Servidor pronto.'));

// 6. Rotas de processamento

// 6.1 Cortar vídeos
app.post('/cortar-video', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).send('Nenhum ficheiro enviado.');
    const { startTime, endTime } = req.body;
    const timeRegex = /^(?:[0-9]+(?:\.[0-9]*)?|[0-5]?\d:[0-5]?\d:[0-5]?\d(?:\.\d+)?)$/;
    if (!startTime || !endTime || !timeRegex.test(startTime) || !timeRegex.test(endTime)) {
        files.forEach(f => fs.unlinkSync(f.path));
        return res.status(400).send('Formato de tempo inválido.');
    }
    try {
        const processedFiles = [];
        const filesToDelete = [];
        for (const file of files) {
            const inputPath = file.path;
            const outputFilename = `cortado-${file.filename}`;
            const outputPath = path.join(processedDir, outputFilename);
            await runFFmpeg(`ffmpeg -i "${inputPath}" -ss ${startTime} -to ${endTime} -c copy "${outputPath}"`);
            processedFiles.push({ path: outputPath, name: outputFilename });
            filesToDelete.push(inputPath, outputPath);
        }
        sendZipResponse(res, processedFiles, filesToDelete);
    } catch (e) {
        files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
        res.status(500).send(e.message);
    }
});

// 6.2 Unir vídeos
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
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy "${outputPath}"`);
        sendZipResponse(res, [{ path: outputPath, name: outputFilename }], filesToDelete);
    } catch (e) {
        filesToDelete.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        res.status(500).send(e.message);
    }
});

// 6.3 Comprimir vídeos
app.post('/comprimir-videos', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).send('Nenhum ficheiro enviado.');
    const quality = req.body.quality;
    const crfMap = { alta: '18', media: '23', baixa: '28' };
    const crf = crfMap[quality];
    if (!crf) {
        files.forEach(f => fs.unlinkSync(f.path));
        return res.status(400).send('Qualidade inválida.');
    }
    try {
        const processedFiles = [];
        const filesToDelete = [];
        for (const file of files) {
            const inputPath = file.path;
            const outputFilename = `comprimido-${file.filename}`;
            const outputPath = path.join(processedDir, outputFilename);
            await runFFmpeg(`ffmpeg -i "${inputPath}" -vcodec libx264 -crf ${crf} "${outputPath}"`);
            processedFiles.push({ path: outputPath, name: outputFilename });
            filesToDelete.push(inputPath, outputPath);
        }
        sendZipResponse(res, processedFiles, filesToDelete);
    } catch (e) {
        files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
        res.status(500).send(e.message);
    }
});

// 6.4 Remover áudio ou metadata
app.post('/remover-audio', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).send('Nenhum ficheiro enviado.');
    if (req.body.removeAudio !== 'true' && req.body.removeMetadata !== 'true') {
        return res.status(400).send('Nenhuma opção selecionada.');
    }
    try {
        const processedFiles = [];
        const filesToDelete = [];
        for (const file of files) {
            const inputPath = file.path;
            const outputFilename = `processado-${file.filename}`;
            const outputPath = path.join(processedDir, outputFilename);
            let flags = '-c:v copy';
            if (req.body.removeAudio === 'true') flags += ' -an';
            else flags += ' -c:a copy';
            if (req.body.removeMetadata === 'true') flags += ' -map_metadata -1';
            await runFFmpeg(`ffmpeg -i "${inputPath}" ${flags} "${outputPath}"`);
            processedFiles.push({ path: outputPath, name: outputFilename });
            filesToDelete.push(inputPath, outputPath);
        }
        sendZipResponse(res, processedFiles, filesToDelete);
    } catch (e) {
        files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
        res.status(500).send(e.message);
    }
});

// 6.5 IA Turbo - mixar vídeo avançado
app.post('/mixar-video-turbo', upload.fields([
    { name: 'narration', maxCount: 1 },
    { name: 'images', maxCount: 50 },
    { name: 'script', maxCount: 1 }
]), async (req, res) => {
    try {
        const narrationFile = req.files['narration'][0].path;
        const scriptText = req.body.script;
        const imagesArray = JSON.parse(req.body.images);
        const imageDuration = parseFloat(req.body.imageDuration) || 5;

        // Criar lista de imagens
        const listFilePath = path.join(uploadDir, `list-turbo-${Date.now()}.txt`);
        let lines = [];
        imagesArray.forEach(img => {
            lines.push(`file '${img}'`);
            lines.push(`duration ${imageDuration}`);
        });
        fs.writeFileSync(listFilePath, lines.join('\n'));

        // Frames
        const frameRate = 25;
        const totalFrames = Math.ceil(imageDuration * frameRate);

        // Compor vídeo final
        const outputName = `turbo-${Date.now()}.mp4`;
        const outputPath = path.join(processedDir, outputName);
        const ffmpegCmd = `
ffmpeg -f concat -safe 0 -i "${listFilePath}" \
-i "${narrationFile}" \
-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1,zoompan=z='min(zoom+0.0015,1.5)':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080,format=yuv420p" \
-c:v libx264 -r ${frameRate} -c:a aac -shortest "${outputPath}" -y
`;
        await runFFmpeg(ffmpegCmd.trim());

        res.download(outputPath);
    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});

// 7. Iniciar Servidor
app.listen(PORT, () => {
    console.log(`Servidor a correr na porta ${PORT}`);
});
