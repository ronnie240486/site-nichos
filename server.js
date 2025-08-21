// 1. Importações
const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

// 2. Configuração inicial
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// 3. Configuração Multer para upload
const upload = multer({ dest: 'uploads/' });

// 4. Rota para upload de vídeo local
app.post('/upload-video', upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).send('Nenhum arquivo enviado.');

    const inputPath = req.file.path;
    const baseName = path.parse(req.file.originalname).name;
    const wavPath = `processed/${baseName}.wav`;
    const mp3Path = `processed/${baseName}.mp3`;

    // Criar pasta processed se não existir
    if (!fs.existsSync('processed')) fs.mkdirSync('processed');

    // 4.1 Gerar WAV
    exec(`ffmpeg -i "${inputPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${wavPath}"`, (err) => {
        if (err) return res.status(500).send(`Erro ao gerar WAV: ${err.message}`);

        // 4.2 Gerar MP3
        exec(`ffmpeg -i "${inputPath}" -vn -acodec libmp3lame -q:a 2 "${mp3Path}"`, (err2) => {
            if (err2) return res.status(500).send(`Erro ao gerar MP3: ${err2.message}`);

            res.send({
                message: 'Áudio extraído com sucesso!',
                wav: wavPath,
                mp3: mp3Path
            });
        });
    });
});

// 5. Rota para extrair áudio de YouTube
app.post('/youtube-audio', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send('URL do YouTube é obrigatória.');

    const baseName = `youtube_${Date.now()}`;
    const wavPath = `processed/${baseName}.wav`;
    const mp3Path = `processed/${baseName}.mp3`;

    if (!fs.existsSync('processed')) fs.mkdirSync('processed');

    // 5.1 Baixar e converter para WAV
    exec(`yt-dlp -x --audio-format wav -o "processed/${baseName}.wav" ${url}`, (err) => {
        if (err) return res.status(500).send(`Erro ao gerar WAV: ${err.message}`);

        // 5.2 Baixar e converter para MP3
        exec(`yt-dlp -x --audio-format mp3 -o "processed/${baseName}.mp3" ${url}`, (err2) => {
            if (err2) return res.status(500).send(`Erro ao gerar MP3: ${err2.message}`);

            res.send({
                message: 'Áudio do YouTube extraído com sucesso!',
                wav: wavPath,
                mp3: mp3Path
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

function safeDeleteFiles(files) {
    files.forEach(f => {
        if (fs.existsSync(f)) {
            try { 
                fs.unlinkSync(f);
                console.log(`Ficheiro temporário removido: ${f}`);
            } catch(e) { 
                console.error(`Erro ao deletar ${f}:`, e); 
            }
        }
    });
}

function sendZipResponse(res, filesToZip, allTempFiles) {
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=resultado.zip');
    
    archive.on('error', (err) => { 
        console.error("Erro no Archiver:", err);
        safeDeleteFiles(allTempFiles);
        if (!res.headersSent) {
            res.status(500).send("Erro ao criar o arquivo zip.");
        }
    });

    res.on('close', () => {
        console.log('Conexão fechada, limpando ficheiros.');
        safeDeleteFiles(allTempFiles);
    });

    archive.pipe(res);
    filesToZip.forEach(file => {
        archive.file(file.path, { name: file.name });
    });
    archive.finalize();
}

// --- FUNÇÃO COMPLETA COM OS 25 EFEITOS ---
function getEffectFilter(effectName, durationPerImage, dValue, videoWidth, videoHeight) {
    const fadeDuration = Math.min(1, durationPerImage / 2);
    switch (effectName) {
        case 'zoom':
            return `zoompan=z='min(zoom+0.0015,1.5)':d=${dValue}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${videoWidth}x${videoHeight}`;
        case 'fade':
            return `fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${durationPerImage - fadeDuration}:d=${fadeDuration}`;
        case 'glitch':
            return `frei0r=glitch0r`;
        case 'retro':
            return `vignette,format=yuv420p`;
        case 'blur':
            return `gblur=sigma=5:enable='between(t,0,${durationPerImage})'`;
        case 'grayscale':
            return `format=gray`;
        case 'sepia':
            return `colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131`;
        case 'shake':
            return `frei0r=vertigo`;
        case 'flash':
            return `colorlevels=rimin=0.5:gimin=0.5:bimin=0.5`;
        case 'invert':
            return `negate`;
        case 'slide-left':
            return `overlay=x='-w+(t/${durationPerImage})*w':y=0`;
        case 'slide-right':
            return `overlay=x='w-(t/${durationPerImage})*w':y=0`;
        case 'slide-up':
            return `overlay=x=0:y='-h+(t/${durationPerImage})*h'`;
        case 'slide-down':
            return `overlay=x=0:y='h-(t/${durationPerImage})*h'`;
        case 'rotate':
            return `rotate=angle=2*PI*t/${durationPerImage}:fillcolor=black`;
        case 'pulse':
            return `scale=w='iw*abs(1.05-0.05*sin(2*PI*t/${durationPerImage}))':h='ih*abs(1.05-0.05*sin(2*PI*t/${durationPerImage}))'`;
        case 'neon':
            return `frei0r=glow`;
        case 'rainbow':
            return `frei0r=rgbparade`;
        case 'old-film':
            return `frei0r=oldfilm`;
        case 'pixel':
            return `pixelize=w=32:h=32`;
        case 'cartoon':
            return `frei0r=cartoon`;
        case 'matrix':
            return `frei0r=matrix`;
        case '3d':
            return `frei0r=threed`;
        case 'mirror':
            return `hflip`;
        case 'fire':
            return `frei0r=burn`;
        default:
            return `zoompan=z='min(zoom+0.0015,1.5)':d=${dValue}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${videoWidth}x${videoHeight}`;
    }
}

// --- ROTAS DE FERRAMENTAS GERAIS ---

app.post('/cortar-video', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).send('Nenhum ficheiro enviado.');
    
    const allTempFiles = files.map(f => f.path);
    try {
        const { startTime, endTime } = req.body;
        const processedFiles = [];
        for (const file of files) {
            const outputPath = path.join(processedDir, `cortado-${file.filename}`);
            allTempFiles.push(outputPath);
            await runFFmpeg(`ffmpeg -i "${file.path}" -ss ${startTime} -to ${endTime} -c copy -y "${outputPath}"`);
            processedFiles.push({ path: outputPath, name: path.basename(outputPath) });
        }
        sendZipResponse(res, processedFiles, allTempFiles);
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

app.post('/unir-videos', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length < 2) return res.status(400).send('Mínimo 2 vídeos.');
    
    const fileListPath = path.join(uploadDir, `list-${Date.now()}.txt`);
    const outputPath = path.join(processedDir, `unido-${Date.now()}.mp4`);
    const allTempFiles = [...files.map(f => f.path), fileListPath, outputPath];
    
    try {
        const fileContent = files.map(f => `file '${f.path.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(fileListPath, fileContent);
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy -y "${outputPath}"`);
        sendZipResponse(res, [{ path: outputPath, name: path.basename(outputPath) }], allTempFiles);
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

app.post('/comprimir-videos', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).send('Nenhum ficheiro enviado.');

    const allTempFiles = files.map(f => f.path);
    try {
        const quality = req.body.quality;
        const crfMap = { alta: '18', media: '23', baixa: '28' };
        const crf = crfMap[quality];
        if (!crf) throw new Error('Qualidade inválida.');

        const processedFiles = [];
        for (const file of files) {
            const outputPath = path.join(processedDir, `comprimido-${file.filename}`);
            allTempFiles.push(outputPath);
            await runFFmpeg(`ffmpeg -i "${file.path}" -vcodec libx264 -crf ${crf} -preset fast -y "${outputPath}"`);
            processedFiles.push({ path: outputPath, name: path.basename(outputPath) });
        }
        sendZipResponse(res, processedFiles, allTempFiles);
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

app.post('/embaralhar-videos', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length < 2) return res.status(400).send('Mínimo 2 vídeos.');
    
    const shuffled = files.sort(() => Math.random() - 0.5);
    const fileListPath = path.join(uploadDir, `list-shuf-${Date.now()}.txt`);
    const outputPath = path.join(processedDir, `embaralhado-${Date.now()}.mp4`);
    const allTempFiles = [...files.map(f => f.path), fileListPath, outputPath];
    
    try {
        const fileContent = shuffled.map(f => `file '${f.path.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(fileListPath, fileContent);
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy -y "${outputPath}"`);
        sendZipResponse(res, [{ path: outputPath, name: path.basename(outputPath) }], allTempFiles);
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

app.post('/remover-audio', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).send('Nenhum ficheiro enviado.');

    const allTempFiles = files.map(f => f.path);
    try {
        const processedFiles = [];
        for (const file of files) {
            const outputPath = path.join(processedDir, `processado-${file.filename}`);
            allTempFiles.push(outputPath);
            let flags = '-c:v copy';
            if (req.body.removeAudio === 'true') flags += ' -an';
            else flags += ' -c:a copy';
            if (req.body.removeMetadata === 'true') flags += ' -map_metadata -1';
            await runFFmpeg(`ffmpeg -i "${file.path}" ${flags} -y "${outputPath}"`);
            processedFiles.push({ path: outputPath, name: path.basename(outputPath) });
        }
        sendZipResponse(res, processedFiles, allTempFiles);
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

// --- ROTAS DE FERRAMENTAS GERAIS ---

app.post('/cortar-video', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).send('Nenhum ficheiro enviado.');
    
    const allTempFiles = files.map(f => f.path);
    try {
        const { startTime, endTime } = req.body;
        const processedFiles = [];
        for (const file of files) {
            const outputPath = path.join(processedDir, `cortado-${file.filename}`);
            allTempFiles.push(outputPath);
            await runFFmpeg(`ffmpeg -i "${file.path}" -ss ${startTime} -to ${endTime} -c copy -y "${outputPath}"`);
            processedFiles.push({ path: outputPath, name: path.basename(outputPath) });
        }
        sendZipResponse(res, processedFiles, allTempFiles);
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

app.post('/unir-videos', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length < 2) return res.status(400).send('Mínimo 2 vídeos.');
    
    const fileListPath = path.join(uploadDir, `list-${Date.now()}.txt`);
    const outputPath = path.join(processedDir, `unido-${Date.now()}.mp4`);
    const allTempFiles = [...files.map(f => f.path), fileListPath, outputPath];
    
    try {
        const fileContent = files.map(f => `file '${f.path.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(fileListPath, fileContent);
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy -y "${outputPath}"`);
        sendZipResponse(res, [{ path: outputPath, name: path.basename(outputPath) }], allTempFiles);
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

app.post('/comprimir-videos', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).send('Nenhum ficheiro enviado.');

    const allTempFiles = files.map(f => f.path);
    try {
        const quality = req.body.quality;
        const crfMap = { alta: '18', media: '23', baixa: '28' };
        const crf = crfMap[quality];
        if (!crf) throw new Error('Qualidade inválida.');

        const processedFiles = [];
        for (const file of files) {
            const outputPath = path.join(processedDir, `comprimido-${file.filename}`);
            allTempFiles.push(outputPath);
            await runFFmpeg(`ffmpeg -i "${file.path}" -vcodec libx264 -crf ${crf} -preset fast -y "${outputPath}"`);
            processedFiles.push({ path: outputPath, name: path.basename(outputPath) });
        }
        sendZipResponse(res, processedFiles, allTempFiles);
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

// Ferramentas de Áudio
app.post('/unir-audio', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length < 2) return res.status(400).send('Mínimo 2 áudios.');
    
    const fileListPath = path.join(uploadDir, `list-audio-${Date.now()}.txt`);
    const outputPath = path.join(processedDir, `unido-${Date.now()}.mp3`);
    const allTempFiles = [...files.map(f => f.path), fileListPath, outputPath];
    
    try {
        const fileContent = files.map(f => `file '${f.path.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(fileListPath, fileContent);
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c:a libmp3lame -y "${outputPath}"`);
        sendZipResponse(res, [{ path: outputPath, name: path.basename(outputPath) }], allTempFiles);
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

app.post('/limpar-metadados-audio', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).send('Nenhum ficheiro enviado.');

    const allTempFiles = files.map(f => f.path);
    try {
        const processedFiles = [];
        for (const file of files) {
            const outputPath = path.join(processedDir, `limpo-${file.filename}`);
            allTempFiles.push(outputPath);
            await runFFmpeg(`ffmpeg -i "${file.path}" -map_metadata -1 -c:a copy -y "${outputPath}"`);
            processedFiles.push({ path: outputPath, name: path.basename(outputPath) });
        }
        sendZipResponse(res, processedFiles, allTempFiles);
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

app.post('/embaralhar-audio', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length < 2) return res.status(400).send('Mínimo 2 áudios.');
    
    const shuffled = files.sort(() => Math.random() - 0.5);
    const fileListPath = path.join(uploadDir, `list-audio-shuf-${Date.now()}.txt`);
    const outputPath = path.join(processedDir, `embaralhado-${Date.now()}.mp3`);
    const allTempFiles = [...files.map(f => f.path), fileListPath, outputPath];
    
    try {
        const fileContent = shuffled.map(f => `file '${f.path.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(fileListPath, fileContent);
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c:a libmp3lame -y "${outputPath}"`);
        sendZipResponse(res, [{ path: outputPath, name: path.basename(outputPath) }], allTempFiles);
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

app.post('/melhorar-audio', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).send('Nenhum ficheiro enviado.');

    const allTempFiles = files.map(f => f.path);
    try {
        const processedFiles = [];
        for (const file of files) {
            const outputPath = path.join(processedDir, `melhorado-${file.filename}`);
            allTempFiles.push(outputPath);
            const filters = "highpass=f=200,lowpass=f=3000,acompressor";
            await runFFmpeg(`ffmpeg -i "${file.path}" -af "${filters}" -y "${outputPath}"`);
            processedFiles.push({ path: outputPath, name: path.basename(outputPath) });
        }
        sendZipResponse(res, processedFiles, allTempFiles);
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

app.post('/remover-silencio', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).send('Nenhum ficheiro enviado.');

    const allTempFiles = files.map(f => f.path);
    try {
        const processedFiles = [];
        for (const file of files) {
            const outputPath = path.join(processedDir, `sem-silencio-${file.filename}`);
            allTempFiles.push(outputPath);
            const filters = "silenceremove=start_periods=1:start_threshold=-30dB:stop_periods=-1:stop_duration=1:stop_threshold=-30dB";
            await runFFmpeg(`ffmpeg -i "${file.path}" -af "${filters}" -y "${outputPath}"`);
            processedFiles.push({ path: outputPath, name: path.basename(outputPath) });
        }
        sendZipResponse(res, processedFiles, allTempFiles);
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

// --- ROTAS DO IA TURBO ---

app.post('/extrair-audio', upload.single('video'), async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).send('Nenhum ficheiro de vídeo enviado.');

    const allTempFiles = [file.path];
    try {
        const outputPath = path.join(processedDir, `audio-ext-${Date.now()}.wav`);
        allTempFiles.push(outputPath);
        await runFFmpeg(`ffmpeg -i "${file.path}" -vn -acodec pcm_s16le -ar 16000 -ac 1 -y "${outputPath}"`);
        res.sendFile(outputPath, (err) => {
            if (err) console.error('Erro ao enviar ficheiro de áudio:', err);
            safeDeleteFiles(allTempFiles);
        });
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

app.post('/transcrever-audio', upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'googleCreds', maxCount: 1 },
    { name: 'languageCode', maxCount: 1 }
]), async (req, res) => {
    const audioFile = req.files.audio?.[0];
    const { googleCreds, languageCode = 'pt-BR' } = req.body;
    if (!audioFile || !googleCreds) return res.status(400).send('Dados insuficientes.');

    const allTempFiles = [audioFile.path];
    try {
        let creds;
        try {
            creds = JSON.parse(googleCreds);
        } catch (jsonError) {
            throw new Error("As credenciais do Google Cloud não são um JSON válido.");
        }
        
        const tempCredsPath = path.join(uploadDir, `creds-${Date.now()}.json`);
        fs.writeFileSync(tempCredsPath, JSON.stringify(creds));
        allTempFiles.push(tempCredsPath);

        const speechClient = new SpeechClient({ keyFilename: tempCredsPath });
        const audioBytes = fs.readFileSync(audioFile.path).toString('base64');
        
        const request = {
            audio: { content: audioBytes },
            config: { encoding: 'WAV', sampleRateHertz: 16000, languageCode: languageCode, model: 'default' },
        };

        const [response] = await speechClient.recognize(request);
        const transcription = response.results.map(result => result.alternatives[0].transcript).join('\n');
        
        res.json({ script: transcription || "Não foi possível transcrever o áudio." });
    } catch (e) {
        res.status(500).send(e.message);
    } finally {
        safeDeleteFiles(allTempFiles);
    }
});

app.post('/extrair-frames', upload.single('video'), async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).send('Nenhum ficheiro de vídeo enviado.');

    const allTempFiles = [file.path];
    try {
        const uniquePrefix = `frame-${Date.now()}`;
        const outputPattern = path.join(processedDir, `${uniquePrefix}-%03d.png`);
        
        await runFFmpeg(`ffmpeg -i "${file.path}" -vf fps=1 -y "${outputPattern}"`);
        
        const frameFiles = fs.readdirSync(processedDir).filter(f => f.startsWith(uniquePrefix));
        allTempFiles.push(...frameFiles.map(f => path.join(processedDir, f)));

        const base64Frames = frameFiles.map(frameFile => {
            const framePath = path.join(processedDir, frameFile);
            const bitmap = fs.readFileSync(framePath);
            return `data:image/png;base64,${Buffer.from(bitmap).toString('base64')}`;
        });
        
        res.json({ frames: base64Frames });
    } catch (e) {
        res.status(500).send(e.message);
    } finally {
        safeDeleteFiles(allTempFiles);
    }
});

// --- ROTA OTIMIZADA COM COMANDO ÚNICO ---
app.post('/mixar-video-turbo', upload.single('narration'), async (req, res) => {
    const narrationFile = req.file;
    const { images, script, imageDuration } = req.body;
    if (!narrationFile || !images || !script) {
        if (narrationFile) safeDeleteFiles([narrationFile.path]);
        return res.status(400).send('Dados insuficientes para mixar o vídeo.');
    }

    let allTempFiles = [narrationFile.path];
    try {
        const imageArray = JSON.parse(images);
        const imagePaths = imageArray.map((dataUrl, i) => {
            const base64Data = dataUrl.replace(/^data:image\/(png|jpeg|webp);base64,/, "");
            const imagePath = path.join(uploadDir, `turbo-img-${Date.now()}-${i}.png`);
            fs.writeFileSync(imagePath, base64Data, 'base64');
            allTempFiles.push(imagePath);
            return imagePath;
        });

        let durationPerImage;
        const parsedImageDuration = parseFloat(imageDuration);
        if (parsedImageDuration > 0) {
            durationPerImage = parsedImageDuration;
        } else {
            const audioDuration = await getMediaDuration(narrationFile.path);
            durationPerImage = audioDuration / imagePaths.length;
        }

        const fileListPath = path.join(uploadDir, `list-turbo-${Date.now()}.txt`);
        allTempFiles.push(fileListPath);
        
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
        
        const frameRate = 25;
        const totalFrames = Math.max(1, Math.round(durationPerImage * frameRate));
        const outputPath = path.join(processedDir, `turbo-${Date.now()}.mp4`);
        allTempFiles.push(outputPath);

        const ffmpegCmd = `ffmpeg -f concat -safe 0 -i "${fileListPath}" -i "${narrationFile.path}" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1,zoompan=z='min(zoom+0.0015,1.5)':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080,format=yuv420p" -c:v libx264 -r ${frameRate} -c:a aac -shortest "${outputPath}" -y`;
        
        await runFFmpeg(ffmpegCmd.trim());

        res.sendFile(outputPath, (err) => {
            if (err) console.error('Erro ao enviar vídeo final:', err);
            safeDeleteFiles(allTempFiles);
        });

    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

// --- ROTA AVANÇADA PARA VÍDEOS LONGOS COM LEGENDAS ---
app.post('/mixar-video-turbo-advanced', upload.single('narration'), async (req, res) => {
    const narrationFile = req.file;
    const { images, script, imageDuration, videoType, blockSize } = req.body;

    if (!narrationFile || !images || !script) {
        if (narrationFile) safeDeleteFiles([narrationFile.path]);
        return res.status(400).send('Dados insuficientes para mixar o vídeo.');
    }

    const imageArray = JSON.parse(images);
    const scriptLines = script.split(/\r?\n/).filter(l => l.trim() !== '');
    let allTempFiles = [narrationFile.path];

    try {
        const isShort = videoType === 'short';
        const videoWidth = isShort ? 1080 : 1920;
        const videoHeight = isShort ? 1920 : 1080;

        const blocks = [];
        const blockLen = parseInt(blockSize) || 10;
        for (let i = 0; i < imageArray.length; i += blockLen) {
            blocks.push(imageArray.slice(i, i + blockLen));
        }

        const blockVideoPaths = [];

        for (let b = 0; b < blocks.length; b++) {
            console.log(`Processando bloco ${b + 1} de ${blocks.length}...`);
            const blockImages = blocks[b];
            const imagePaths = blockImages.map((dataUrl, i) => {
                const base64Data = dataUrl.replace(/^data:image\/(png|jpeg|webp);base64,/, "");
                const imagePath = path.join(uploadDir, `block${b}-${Date.now()}-${i}.png`);
                fs.writeFileSync(imagePath, base64Data, 'base64');
                allTempFiles.push(imagePath);
                return imagePath;
            });

            let durationPerImage;
            const parsedImageDuration = parseFloat(imageDuration);
            if (parsedImageDuration > 0) {
                durationPerImage = parsedImageDuration;
            } else {
                const audioDuration = await getMediaDuration(narrationFile.path);
                durationPerImage = audioDuration / imageArray.length;
            }

            const fileListPath = path.join(uploadDir, `list-block${b}-${Date.now()}.txt`);
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
            allTempFiles.push(fileListPath);

            const silentVideoPath = path.join(processedDir, `silent-block${b}-${Date.now()}.mp4`);
            allTempFiles.push(silentVideoPath);
            const fps = 25;
            const dValue = Math.max(1, Math.round(durationPerImage * fps));
            const kenBurnsEffect = `zoompan=z='min(zoom+0.0015,1.5)':d=${dValue}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${videoWidth}x${videoHeight}`;

            await runFFmpeg(
                `ffmpeg -f concat -safe 0 -i "${fileListPath}" ` +
                `-vf "scale=${videoWidth}:${videoHeight}:force_original_aspect_ratio=decrease,pad=${videoWidth}:${videoHeight}:-1:-1,${kenBurnsEffect},format=yuv420p" ` +
                `-c:v libx264 -r ${fps} -y "${silentVideoPath}"`
            );

            blockVideoPaths.push(silentVideoPath);
        }

        console.log("Concatenando blocos de vídeo...");
        const finalListPath = path.join(uploadDir, `list-final-${Date.now()}.txt`);
        const fileContentFinal = blockVideoPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(finalListPath, fileContentFinal);
        allTempFiles.push(finalListPath);

        const finalSilentPath = path.join(processedDir, `silent-final-${Date.now()}.mp4`);
        allTempFiles.push(finalSilentPath);
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${finalListPath}" -c copy -y "${finalSilentPath}"`);

        console.log("Gerando legendas SRT...");
        let srtContent = "";
        let currentTime = 0.0;
        const audioDuration = await getMediaDuration(narrationFile.path);
        const totalWords = scriptLines.reduce((acc, l) => acc + l.split(/\s+/).length, 0);
        const perWordDuration = totalWords > 0 ? audioDuration / totalWords : 0;

        function formatTime(seconds) {
            const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
            const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
            const s = Math.floor(seconds % 60).toString().padStart(2, '0');
            const ms = Math.floor((seconds % 1) * 1000).toString().padStart(3, '0');
            return `${h}:${m}:${s},${ms}`;
        }

        scriptLines.forEach((line, index) => {
            const wordsCount = line.split(/\s+/).length;
            const duration = perWordDuration * wordsCount;
            const start = formatTime(currentTime);
            const end = formatTime(currentTime + duration);
            srtContent += `${index + 1}\n${start} --> ${end}\n${line}\n\n`;
            currentTime += duration;
        });

        const srtPath = path.join(uploadDir, `subtitles-${Date.now()}.srt`);
        fs.writeFileSync(srtPath, srtContent);
        allTempFiles.push(srtPath);

        console.log("Mixando áudio e legendas...");
        const outputPath = path.join(processedDir, `video-final-turbo-adv-${Date.now()}.mp4`);
        allTempFiles.push(outputPath);

        await runFFmpeg(
            `ffmpeg -i "${finalSilentPath}" -i "${narrationFile.path}" ` +
            `-vf "subtitles='${srtPath.replace(/\\/g, '/')}'" ` +
            `-c:v libx264 -c:a aac -shortest -y "${outputPath}"`
        );

        res.sendFile(outputPath, (err) => {
            if (err) console.error('Erro ao enviar vídeo final:', err);
            safeDeleteFiles(allTempFiles);
        });

    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

// --- ROTA PARA GERAR ZIP COMPLETO ---
app.post('/download-turbo-zip', upload.single('narration'), async (req, res) => {
    const narrationFile = req.file;
    const { images, script, imageDuration, videoType, blockSize } = req.body;

    if (!narrationFile || !images || !script) {
        if (narrationFile) safeDeleteFiles([narrationFile.path]);
        return res.status(400).send('Dados insuficientes para criar o ZIP.');
    }

    const imageArray = JSON.parse(images);
    const scriptLines = script.split(/\r?\n/).filter(l => l.trim() !== '');
    let allTempFiles = [narrationFile.path];
    const filesToZip = [];

    try {
        const isShort = videoType === 'short';
        const videoWidth = isShort ? 1080 : 1920;
        const videoHeight = isShort ? 1920 : 1080;

        const blocks = [];
        const blockLen = parseInt(blockSize) || 10;
        for (let i = 0; i < imageArray.length; i += blockLen) {
            blocks.push(imageArray.slice(i, i + blockLen));
        }

        const blockVideoPaths = [];

        for (let b = 0; b < blocks.length; b++) {
            const blockImages = blocks[b];
            const imagePaths = blockImages.map((dataUrl, i) => {
                const base64Data = dataUrl.replace(/^data:image\/(png|jpeg|webp);base64,/, "");
                const imagePath = path.join(uploadDir, `block${b}-${Date.now()}-${i}.png`);
                fs.writeFileSync(imagePath, base64Data, 'base64');
                allTempFiles.push(imagePath);
                filesToZip.push({ path: imagePath, name: `images/block${b}-image${i}.png` });
                return imagePath;
            });

            let durationPerImage;
            const parsedImageDuration = parseFloat(imageDuration);
            if (parsedImageDuration > 0) {
                durationPerImage = parsedImageDuration;
            } else {
                const audioDuration = await getMediaDuration(narrationFile.path);
                durationPerImage = audioDuration / imageArray.length;
            }

            const fileListPath = path.join(uploadDir, `list-block${b}-${Date.now()}.txt`);
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
            allTempFiles.push(fileListPath);

            const silentVideoPath = path.join(processedDir, `silent-block${b}-${Date.now()}.mp4`);
            allTempFiles.push(silentVideoPath);
            blockVideoPaths.push(silentVideoPath);
            filesToZip.push({ path: silentVideoPath, name: `videos/silent-block${b}.mp4` });

            const fps = 25;
            const dValue = Math.max(1, Math.round(durationPerImage * fps));
            const kenBurnsEffect = `zoompan=z='min(zoom+0.0015,1.5)':d=${dValue}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${videoWidth}x${videoHeight}`;

            await runFFmpeg(
                `ffmpeg -f concat -safe 0 -i "${fileListPath}" ` +
                `-vf "scale=${videoWidth}:${videoHeight}:force_original_aspect_ratio=decrease,pad=${videoWidth}:${videoHeight}:-1:-1,${kenBurnsEffect},format=yuv420p" ` +
                `-c:v libx264 -r ${fps} -y "${silentVideoPath}"`
            );
        }

        const finalListPath = path.join(uploadDir, `list-final-${Date.now()}.txt`);
        const fileContentFinal = blockVideoPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(finalListPath, fileContentFinal);
        allTempFiles.push(finalListPath);

        const finalSilentPath = path.join(processedDir, `silent-final-${Date.now()}.mp4`);
        allTempFiles.push(finalSilentPath);
        filesToZip.push({ path: finalSilentPath, name: 'videos/final-silent.mp4' });
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${finalListPath}" -c copy -y "${finalSilentPath}"`);

        // Legendas SRT
        let srtContent = "";
        let currentTime = 0.0;
        const audioDuration = await getMediaDuration(narrationFile.path);
        const totalWords = scriptLines.reduce((acc, l) => acc + l.split(/\s+/).length, 0);
        const perWordDuration = totalWords > 0 ? audioDuration / totalWords : 0;

        function formatTime(seconds) {
            const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
            const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
            const s = Math.floor(seconds % 60).toString().padStart(2, '0');
            const ms = Math.floor((seconds % 1) * 1000).toString().padStart(3, '0');
            return `${h}:${m}:${s},${ms}`;
        }

        scriptLines.forEach((line, index) => {
            const wordsCount = line.split(/\s+/).length;
            const duration = perWordDuration * wordsCount;
            const start = formatTime(currentTime);
            const end = formatTime(currentTime + duration);
            srtContent += `${index + 1}\n${start} --> ${end}\n${line}\n\n`;
            currentTime += duration;
        });

        const srtPath = path.join(uploadDir, `subtitles-${Date.now()}.srt`);
        fs.writeFileSync(srtPath, srtContent);
        allTempFiles.push(srtPath);
        filesToZip.push({ path: srtPath, name: 'subtitles.srt' });

        // Áudio de narração
        filesToZip.push({ path: narrationFile.path, name: 'narration.wav' });

        // Vídeo final com áudio e legendas
        const outputFinalPath = path.join(processedDir, `video-final-turbo-zip-${Date.now()}.mp4`);
        allTempFiles.push(outputFinalPath);
        filesToZip.push({ path: outputFinalPath, name: 'video-final.mp4' });

        await runFFmpeg(
            `ffmpeg -i "${finalSilentPath}" -i "${narrationFile.path}" ` +
            `-vf "subtitles='${srtPath.replace(/\\/g, '/')}'" ` +
            `-c:v libx264 -c:a aac -shortest -y "${outputFinalPath}"`
        );

        // Cria e envia ZIP
        const archive = archiver('zip', { zlib: { level: 9 } });
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename=darkmaker-turbo.zip');
        archive.on('error', (err) => { 
            console.error("Erro no Archiver:", err);
            safeDeleteFiles(allTempFiles);
        });
        res.on('close', () => {
             safeDeleteFiles(allTempFiles);
        });
        archive.pipe(res);
        filesToZip.forEach(file => {
            archive.file(file.path, { name: file.name });
        });
        archive.finalize();

    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

// 6. Iniciar Servidor
app.listen(PORT, () => {
    console.log(`Servidor a correr na porta ${PORT}`);
});




