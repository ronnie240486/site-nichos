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
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/downloads', express.static(processedDir));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}-${safeOriginalName}`);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fieldSize: 50 * 1024 * 1024
    }
});

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
        console.log('Limpando ficheiros temporários...');
        filesToDelete.forEach(file => {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
                console.log(`Ficheiro removido: ${file}`);
            }
        });
    });
    archive.on('error', (err) => { throw err; });
    archive.pipe(res);
    filesToZip.forEach(file => {
        archive.file(file.path, { name: file.name });
    });
    archive.finalize();
}

// 5. Rotas
app.get('/', (req, res) => res.send('Backend DarkMaker está a funcionar!'));
app.get('/status', (req, res) => res.status(200).send('Servidor pronto.'));


app.post('/cortar-video', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).send('Nenhum ficheiro enviado.');
    const { startTime, endTime } = req.body;
    const timeRegex = /^(?:[0-9]+(?:\.[0-9]*)?|[0-5]?\d:[0-5]?\d:[0-5]?\d(?:\.\d+)?)$/;
    if (!startTime || !endTime || !timeRegex.test(startTime) || !timeRegex.test(endTime)) {
        files.forEach(f => fs.unlinkSync(f.path));
        return res.status(400).send('Formato de tempo inválido. Use HH:MM:SS ou segundos.');
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

app.post('/comprimir-videos', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).send('Nenhum ficheiro enviado.');
    const quality = req.body.quality;
    const crfMap = { alta: '18', media: '23', baixa: '28' };
    const crf = crfMap[quality];
    if (!crf) {
        files.forEach(f => fs.unlinkSync(f.path));
        return res.status(400).send('Qualidade inválida. Use "alta", "media" ou "baixa".');
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
    try {
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy "${outputPath}"`);
        sendZipResponse(res, [{ path: outputPath, name: outputFilename }], filesToDelete);
    } catch (e) {
        filesToDelete.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        res.status(500).send(e.message);
    }
});

app.post('/remover-audio', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).send('Nenhum ficheiro enviado.');
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

app.post('/criar-video-automatico', upload.fields([
    { name: 'narration', maxCount: 1 },
    { name: 'media', maxCount: 50 }
]), async (req, res) => {
    const narrationFile = req.files.narration?.[0];
    const mediaFiles = req.files.media || [];
    if (!narrationFile || mediaFiles.length === 0) {
        return res.status(400).send('Narração e pelo menos um ficheiro de media são obrigatórios.');
    }
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
        const finalContent = `${fileContent}\nfile '${lastFile}'`;
        fs.writeFileSync(fileListPath, finalContent);
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" -c:v libx264 -r 25 -y "${silentVideoPath}"`);
        await runFFmpeg(`ffmpeg -i "${silentVideoPath}" -i "${narrationFile.path}" -c:v copy -c:a aac -shortest -y "${outputPath}"`);
        sendZipResponse(res, [{ path: outputPath, name: outputFilename }], filesToDelete);
    } catch (e) {
        filesToDelete.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        res.status(500).send(e.message);
    }
});

// --- ROTAS DO IA TURBO ---

app.post('/extrair-audio', upload.single('video'), async (req, res) => {
    const file = req.file;
    if (!file) {
        return res.status(400).send('Nenhum ficheiro de vídeo enviado.');
    }
    const inputPath = file.path;
    const outputFilename = `audio-ext-${Date.now()}.wav`;
    const outputPath = path.join(processedDir, outputFilename);
    const filesToDelete = [inputPath, outputPath];
    try {
        await runFFmpeg(`ffmpeg -i "${inputPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${outputPath}"`);
        res.sendFile(outputPath, (err) => {
            if (err) console.error('Erro ao enviar ficheiro de áudio:', err);
            filesToDelete.forEach(f => fs.unlinkSync(f));
        });
    } catch (e) {
        filesToDelete.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        res.status(500).send(e.message);
    }
});

app.post('/transcrever-audio', upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'googleCreds', maxCount: 1 },
    { name: 'languageCode', maxCount: 1 }
]), async (req, res) => {
    const audioFile = req.files.audio?.[0];
    const googleCredsString = req.body.googleCreds;
    const languageCode = req.body.languageCode || 'pt-BR';

    if (!audioFile) {
        return res.status(400).send('Nenhum ficheiro de áudio enviado.');
    }
    if (!googleCredsString) {
        return res.status(400).send('Credenciais do Google Cloud não enviadas.');
    }

    const filesToDelete = [audioFile.path];
    let tempCredsPath;

    try {
        const creds = JSON.parse(googleCredsString);
        tempCredsPath = path.join(__dirname, 'uploads', `creds-${Date.now()}.json`);
        fs.writeFileSync(tempCredsPath, JSON.stringify(creds));
        filesToDelete.push(tempCredsPath);

        const speechClient = new SpeechClient({
            keyFilename: tempCredsPath
        });

        const audioBytes = fs.readFileSync(audioFile.path).toString('base64');
        const audio = { content: audioBytes };
        const config = {
            encoding: 'WAV',
            sampleRateHertz: 16000,
            languageCode: languageCode,
            model: 'default',
        };
        const request = { audio: audio, config: config };

        console.log(`Enviando áudio para a API do Google com o idioma: ${languageCode}...`);
        const [response] = await speechClient.recognize(request);
        const transcription = response.results
            .map(result => result.alternatives[0].transcript)
            .join('\n');

        console.log(`Transcrição recebida: ${transcription}`);
        
        res.json({ script: transcription || "Não foi possível transcrever o áudio." });

    } catch (e) {
        console.error("Erro na transcrição:", e);
        res.status(500).send(e.message);
    } finally {
        filesToDelete.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    }
});

app.post('/extrair-frames', upload.single('video'), async (req, res) => {
    const file = req.file;
    if (!file) {
        return res.status(400).send('Nenhum ficheiro de vídeo enviado.');
    }
    const inputPath = file.path;
    const uniquePrefix = `frame-${Date.now()}`;
    const outputPattern = path.join(processedDir, `${uniquePrefix}-%03d.png`);
    let filesToDelete = [inputPath];
    try {
        const duration = await getMediaDuration(inputPath);
        const frameCount = Math.min(Math.floor(duration / 5), 8) || 1;
        const fps = frameCount / duration;
        await runFFmpeg(`ffmpeg -i "${inputPath}" -vf fps=${fps} -vsync vfr "${outputPattern}"`);
        const frameFiles = fs.readdirSync(processedDir).filter(f => f.startsWith(uniquePrefix));
        const base64Frames = frameFiles.map(frameFile => {
            const framePath = path.join(processedDir, frameFile);
            filesToDelete.push(framePath);
            const bitmap = fs.readFileSync(framePath);
            return `data:image/png;base64,${Buffer.from(bitmap).toString('base64')}`;
        });
        res.json({ frames: base64Frames });
    } catch (e) {
        res.status(500).send(e.message);
    } finally {
        filesToDelete.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    }
});

// --- ROTA CORRIGIDA ---
app.post('/mixar-video-turbo', upload.single('narration'), async (req, res) => {
    const narrationFile = req.file;
    const { images, script, imageDuration, transition } = req.body;

    if (!narrationFile || !images || !script) {
        if (narrationFile) fs.unlinkSync(narrationFile.path);
        return res.status(400).send('Dados insuficientes para mixar o vídeo.');
    }

    const imageArray = JSON.parse(images);
    let tempFiles = [narrationFile.path];

    try {
        const imagePaths = imageArray.map((dataUrl, i) => {
            const base64Data = dataUrl.replace(/^data:image\/(png|jpeg|webp);base64,/, "");
            const imagePath = path.join(uploadDir, `turbo-img-${Date.now()}-${i}.png`);
            fs.writeFileSync(imagePath, base64Data, 'base64');
            tempFiles.push(imagePath);
            return imagePath;
        });

        let durationPerImage;
        const parsedImageDuration = parseFloat(imageDuration);

        if (parsedImageDuration && parsedImageDuration > 0) {
            durationPerImage = parsedImageDuration;
            console.log(`Usando duração por imagem fornecida: ${durationPerImage}s`);
        } else {
            const audioDuration = await getMediaDuration(narrationFile.path);
            durationPerImage = audioDuration / imagePaths.length;
            console.log(`Calculando duração sincronizada: ${durationPerImage.toFixed(2)}s`);
        }

        const fileListPath = path.join(uploadDir, `list-turbo-${Date.now()}.txt`);
        
        // --- CORREÇÃO APLICADA AQUI ---
        // A linha que adicionava a última imagem foi removida, pois causava o erro.
        const fileContent = imagePaths.map(p => `file '${p.replace(/'/g, "'\\''")}'\nduration ${durationPerImage}`).join('\n');
        fs.writeFileSync(fileListPath, fileContent);
        // --- FIM DA CORREÇÃO ---

        tempFiles.push(fileListPath);
        
        const silentVideoPath = path.join(processedDir, `silent-turbo-${Date.now()}.mp4`);
        tempFiles.push(silentVideoPath);
        
        const kenBurnsEffect = `zoompan=z='min(zoom+0.0015,1.5)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080`;
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1,${kenBurnsEffect},format=yuv420p" -c:v libx264 -r 25 -y "${silentVideoPath}"`);
        
        const outputFilename = `video-final-turbo-${Date.now()}.mp4`;
        const outputPath = path.join(processedDir, outputFilename);
        tempFiles.push(outputPath);
        
        await runFFmpeg(`ffmpeg -i "${silentVideoPath}" -i "${narrationFile.path}" -c:v copy -c:a aac -shortest -y "${outputPath}"`);
        
        res.sendFile(outputPath, (err) => {
            if (err) console.error('Erro ao enviar vídeo final:', err);
            tempFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        });

    } catch (e) {
        tempFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        res.status(500).send(e.message);
    }
});


// 6. Iniciar Servidor
app.listen(PORT, () => {
    console.log(`Servidor a correr na porta ${PORT}`);
});
