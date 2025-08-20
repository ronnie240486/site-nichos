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
    fileFilter: (req, file, cb) => {
        if (
            file.mimetype.startsWith("video/") ||
            file.mimetype.startsWith("audio/") ||
            file.mimetype.startsWith("image/")
        ) {
            cb(null, true);
        } else {
            cb(new Error("Formato de ficheiro inválido."), false);
        }
    },
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

// --- Exemplo de rota ajustada com res.download ---
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
        res.download(outputPath, outputFilename, (err) => {
            if (err) console.error('Erro ao enviar ficheiro de áudio:', err);
            filesToDelete.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        });
    } catch (e) {
        filesToDelete.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        res.status(500).send(e.message);
    }
});

// --- Transcrição com correção do encoding ---
app.post('/transcrever-audio', upload.single('audio'), async (req, res) => {
    const audioFile = req.file;
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
            encoding: 'LINEAR16',
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

// --- Mixagem Turbo com res.download ---
app.post('/mixar-video-turbo', upload.single('narration'), async (req, res) => {
    const narrationFile = req.file;
    const { images, script, imageDuration } = req.body;

    if (!narrationFile || !images) {
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
        let fileContent = "";
        imagePaths.forEach((p, i) => {
            const safePath = p.replace(/'/g, "'\\''");
            if (i < imagePaths.length - 1) {
                fileContent += `file '${safePath}'\nduration ${durationPerImage}\n`;
            } else {
                fileContent += `file '${safePath}'\n`;
            }
        });
        fs.writeFileSync(fileListPath, fileContent);
        tempFiles.push(fileListPath);

        const silentVideoPath = path.join(processedDir, `silent-turbo-${Date.now()}.mp4`);
        tempFiles.push(silentVideoPath);

        const fps = 25;
        const dValue = Math.max(1, Math.round(durationPerImage * fps));
        const kenBurnsEffect = `zoompan=z='min(zoom+0.0015,1.5)':d=${dValue}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080`;

        await runFFmpeg(
            `ffmpeg -f concat -safe 0 -i "${fileListPath}" ` +
            `-vf "scale=1920:1080:force_original_aspect_ratio=decrease,` +
            `pad=1920:1080:-1:-1,${kenBurnsEffect},format=yuv420p" ` +
            `-c:v libx264 -r ${fps} -y "${silentVideoPath}"`
        );

        const outputFilename = `video-final-turbo-${Date.now()}.mp4`;
        const outputPath = path.join(processedDir, outputFilename);
        tempFiles.push(outputPath);

        await runFFmpeg(`ffmpeg -i "${silentVideoPath}" -i "${narrationFile.path}" -c:v copy -c:a aac -shortest -y "${outputPath}"`);

        res.download(outputPath, outputFilename, (err) => {
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
