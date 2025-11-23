// 1. Importação de Módulos
const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const archiver = require('archiver');
const { SpeechClient } = require('@google-cloud/speech');
const fetch = require('node-fetch');
const FormData = require('form-data');
const youtubedl = require("youtube-dl-exec"); 

// 2. Configuração Inicial
const app = express();
const PORT = process.env.PORT || 10000;

// Estado dos trabalhos em background (Jobs)
const jobs = {};

const uploadDir = path.join(__dirname, 'uploads');
const processedDir = path.join(__dirname, 'processed');

// Garante que as pastas existem
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });

// 3. Middlewares
app.use(cors());
// Aumenta o limite para aceitar JSONs grandes (ex: imagens em Base64)
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));
app.use('/downloads', express.static(processedDir));

// Configuração do Multer (Uploads)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        // Sanitiza o nome do ficheiro
        const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}-${safeOriginalName}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 500 * 1024 * 1024 } // Limite de 500MB por ficheiro
});

// 4. Funções Auxiliares
function runFFmpeg(command) {
    return new Promise((resolve, reject) => {
        console.log(`Executando FFmpeg: ${command}`);
        exec(command, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`FFmpeg Erro: ${stderr}`);
                return reject(new Error(`Erro no FFmpeg: ${stderr || error.message}`));
            }
            resolve(stdout);
        });
    });
}

function safeDeleteFiles(files) {
    if (!files) return;
    files.forEach(f => {
        if (f && fs.existsSync(f)) {
            try {
                fs.unlinkSync(f);
                console.log(`Removido: ${path.basename(f)}`);
            } catch (e) {
                console.error(`Erro ao remover ${f}:`, e);
            }
        }
    });
}

function getMediaDuration(filePath) {
    return new Promise((resolve, reject) => {
        const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
        exec(command, (error, stdout, stderr) => {
            if (error) return reject(new Error(`Erro no ffprobe: ${stderr}`));
            resolve(parseFloat(stdout));
        });
    });
}

function getEffectFilter(transition, durationPerImage, dValue, width, height) {
    // Filtros básicos do FFmpeg
    switch (transition) {
        case 'zoom': // Ken Burns
            return `zoompan=z='min(zoom+0.0015,1.5)':d=${dValue}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
        case 'fade':
            return `fade=t=in:st=0:d=1`;
        default: // Nenhum ou simples scale
            return `null`;
    }
}

function sendZipResponse(res, filesToZip, allTempFiles) {
    if (filesToZip.length === 1) {
        res.sendFile(filesToZip[0].path, (err) => {
            if (err) console.error('Erro ao enviar ficheiro:', err);
            safeDeleteFiles(allTempFiles);
        });
    } else {
        const zipPath = path.join(processedDir, `resultado-${Date.now()}.zip`);
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            res.sendFile(zipPath, (err) => {
                if (err) console.error('Erro ao enviar zip:', err);
                safeDeleteFiles([...allTempFiles, zipPath]);
            });
        });
        archive.on('error', (err) => { throw err; });
        archive.pipe(output);
        filesToZip.forEach(f => archive.file(f.path, { name: f.name }));
        archive.finalize();
    }
}

// 5. Rotas da API

app.get('/', (req, res) => res.send('Backend DarkMaker AI Suite - Online'));
app.get('/status', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// --- SISTEMA DE JOBS (Status e Resultado) ---
app.get('/job-status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs[jobId];
    if (job) {
        res.json({ status: job.status, error: job.error, progress: job.progress });
    } else {
        res.status(404).json({ status: 'not_found' });
    }
});

app.get('/job-result/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs[jobId];
    if (job && job.status === 'completed') {
        if (job.result.isFilePath) {
            res.sendFile(job.result.data, (err) => {
                if (err) console.error(`Erro ao enviar ficheiro do job ${jobId}:`, err);
                safeDeleteFiles([job.result.data]); 
                delete jobs[jobId]; 
            });
        } else {
            res.json(job.result.data);
            delete jobs[jobId];
        }
    } else {
        res.status(404).json({ error: 'Resultado não encontrado ou ainda não está pronto.' });
    }
});

// --- FERRAMENTAS DE VÍDEO ---

// Unir Vídeos
app.post('/unir-videos', upload.array('video'), async (req, res) => { // Campo 'video'
    const files = req.files || [];
    if (files.length < 2) return res.status(400).send('Mínimo 2 vídeos.');
    
    const fileListPath = path.join(uploadDir, `list-${Date.now()}.txt`);
    const outputPath = path.join(processedDir, `unido-${Date.now()}.mp4`);
    const allTempFiles = [...files.map(f => f.path), fileListPath, outputPath];
    
    try {
        const fileContent = files.map(f => `file '${f.path.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(fileListPath, fileContent);
        // Re-encode para garantir compatibilidade
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c:v libx264 -c:a aac -y "${outputPath}"`);
        sendZipResponse(res, [{ path: outputPath, name: 'video_unido.mp4' }], allTempFiles);
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

// Cortar Vídeo
app.post('/cortar-video', upload.single('video'), async (req, res) => {
    const file = req.file;
    const { startTime, endTime } = req.body;
    if (!file) return res.status(400).send('Nenhum vídeo enviado.');

    const outputPath = path.join(processedDir, `cortado-${Date.now()}.mp4`);
    const allTempFiles = [file.path, outputPath];

    try {
        let cmd = `ffmpeg -i "${file.path}"`;
        if (startTime) cmd += ` -ss ${startTime}`;
        if (endTime) cmd += ` -to ${endTime}`;
        cmd += ` -c copy -y "${outputPath}"`; // Copy é mais rápido e sem perda

        await runFFmpeg(cmd);
        res.sendFile(outputPath, (err) => {
            if (err) console.error(err);
            safeDeleteFiles(allTempFiles);
        });
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

// Gerar Shorts (Corte 9:16)
app.post('/gerar-shorts', upload.single('video'), async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).send('Nenhum vídeo enviado.');

    const outputPath = path.join(processedDir, `shorts-${Date.now()}.mp4`);
    const allTempFiles = [file.path, outputPath];

    try {
        // Crop central para 9:16
        await runFFmpeg(`ffmpeg -i "${file.path}" -vf "crop=ih*(9/16):ih" -c:a copy -y "${outputPath}"`);
        res.sendFile(outputPath, (err) => {
            if (err) console.error(err);
            safeDeleteFiles(allTempFiles);
        });
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

// Upscale Vídeo (Simulado via Scale - Real requer modelos pesados)
app.post('/upscale-video', upload.single('video'), async (req, res) => {
    const file = req.file;
    const { resolution } = req.body; // ex: "4K (2160p)"
    if (!file) return res.status(400).send('Nenhum vídeo enviado.');

    const outputPath = path.join(processedDir, `upscale-${Date.now()}.mp4`);
    const allTempFiles = [file.path, outputPath];

    try {
        let scale = "1920:1080"; // FHD Default
        if (resolution && resolution.includes('4K')) scale = "3840:2160";
        else if (resolution && resolution.includes('2K')) scale = "2560:1440";

        await runFFmpeg(`ffmpeg -i "${file.path}" -vf "scale=${scale}:flags=lanczos" -c:v libx264 -crf 18 -c:a copy -y "${outputPath}"`);
        res.sendFile(outputPath, (err) => {
            if (err) console.error(err);
            safeDeleteFiles(allTempFiles);
        });
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

// Colorização (Simulação via Saturation Boost)
app.post('/colorize-video', upload.single('video'), async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).send('Nenhum vídeo enviado.');

    const outputPath = path.join(processedDir, `colorized-${Date.now()}.mp4`);
    const allTempFiles = [file.path, outputPath];

    try {
        // Aumenta a saturação como "efeito" simples, já que DeOldify requer GPU
        await runFFmpeg(`ffmpeg -i "${file.path}" -vf "eq=saturation=1.5:contrast=1.1" -c:a copy -y "${outputPath}"`);
        res.sendFile(outputPath, (err) => {
            if (err) console.error(err);
            safeDeleteFiles(allTempFiles);
        });
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

// --- FERRAMENTAS DE ÁUDIO ---

// Unir Áudios
app.post('/unir-audio', upload.array('files'), async (req, res) => { // Campo 'files' (do GenericAudioTool)
    const files = req.files || [];
    if (files.length < 2) return res.status(400).send('Mínimo 2 áudios.');
    
    const fileListPath = path.join(uploadDir, `list-audio-${Date.now()}.txt`);
    const outputPath = path.join(processedDir, `unido-${Date.now()}.wav`);
    const allTempFiles = [...files.map(f => f.path), fileListPath, outputPath];
    
    try {
        const fileContent = files.map(f => `file '${f.path.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(fileListPath, fileContent);
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c:a pcm_s16le -y "${outputPath}"`);
        res.sendFile(outputPath, (err) => {
            safeDeleteFiles(allTempFiles);
        });
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

// Remover Silêncio
app.post('/remover-silencio', upload.array('files'), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).send('Sem ficheiros.');
    const file = files[0];
    
    const outputPath = path.join(processedDir, `nosilence-${Date.now()}.wav`);
    const allTempFiles = [file.path, outputPath];

    try {
        // Remove silêncio (-50dB)
        await runFFmpeg(`ffmpeg -i "${file.path}" -af silenceremove=stop_periods=-1:stop_duration=1:stop_threshold=-50dB -y "${outputPath}"`);
        res.sendFile(outputPath, (err) => {
            safeDeleteFiles(allTempFiles);
        });
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

// Extrair Áudio de Vídeo
app.post('/extrair-audio', upload.array('files'), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).send('Sem ficheiros.');
    const file = files[0];
    
    const outputPath = path.join(processedDir, `extraido-${Date.now()}.mp3`);
    const allTempFiles = [file.path, outputPath];

    try {
        await runFFmpeg(`ffmpeg -i "${file.path}" -q:a 0 -map a -y "${outputPath}"`);
        res.sendFile(outputPath, (err) => {
            safeDeleteFiles(allTempFiles);
        });
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

// --- IA TURBO & EDITAR AUTOMÁTICO (CORE) ---

// 1. Transcrever Vídeo (Helper para o frontend)
app.post('/transcrever-video', upload.single('video'), async (req, res) => {
    const file = req.file;
    if(!file) return res.status(400).send("Vídeo necessário.");
    const allTempFiles = [file.path];

    try {
        // Extrair áudio
        const audioPath = path.join(uploadDir, `temp-audio-${Date.now()}.wav`);
        allTempFiles.push(audioPath);
        await runFFmpeg(`ffmpeg -i "${file.path}" -vn -acodec pcm_s16le -ar 16000 -ac 1 -y "${audioPath}"`);

        // Transcrever (Simulado se não houver credenciais configuradas no backend, 
        // mas aqui assumimos que o frontend usaria o '/transcrever-audio' com credenciais.
        // Para simplificar, retornamos sucesso com nota para usar o frontend)
        res.json({ 
            script: "Para transcrição real, configure as credenciais do Google Cloud no painel de Settings ou use a API da OpenAI Whisper. Este é um texto de exemplo gerado pelo backend.",
            transcript: "Transcrição simulada do vídeo enviado."
        });
        safeDeleteFiles(allTempFiles);
    } catch (e) {
        safeDeleteFiles(allTempFiles);
        res.status(500).send(e.message);
    }
});

// 2. Extrair Frames (Job)
app.post('/extrair-frames', upload.single('video'), (req, res) => {
    const jobId = `frames_job_${Date.now()}`;
    jobs[jobId] = { status: 'pending' };
    res.json({ success: true, jobId: jobId });

    setImmediate(async () => {
        let videoPath = null;
        let allTempFiles = [];
        if (req.file) {
            videoPath = req.file.path;
            allTempFiles.push(videoPath);
        }

        try {
            jobs[jobId].status = 'processing';
            if (!videoPath && req.body.url) {
                // Lógica YTDL se necessário
            }

            if (!videoPath) throw new Error('Vídeo não encontrado.');

            const uniquePrefix = `frame-${jobId}`;
            const outputPattern = path.join(processedDir, `${uniquePrefix}-%03d.jpg`);
            
            // Extrai 1 frame a cada 5 segundos
            await runFFmpeg(`ffmpeg -i "${videoPath}" -vf fps=1/5 -q:v 2 -y "${outputPattern}"`);
            
            let frameFiles = fs.readdirSync(processedDir).filter(f => f.startsWith(uniquePrefix));
            
            const base64Frames = frameFiles.map(frameFile => {
                const p = path.join(processedDir, frameFile);
                allTempFiles.push(p);
                const bitmap = fs.readFileSync(p);
                return `data:image/jpeg;base64,${Buffer.from(bitmap).toString('base64')}`;
            });
            
            jobs[jobId] = { status: 'completed', result: { isFilePath: false, data: { frames: base64Frames } } };
        } catch (e) {
            jobs[jobId] = { status: 'failed', error: e.message };
        } finally {
            safeDeleteFiles(allTempFiles);
        }
    });
});

// 3. Mixar Vídeo (IA Turbo e Auto Edit)
// IMPORTANTE: Aceita 'narration' (ficheiro) e 'images' (JSON string de Base64/URLs)
app.post('/mixar-video-turbo-advanced', upload.single('narration'), (req, res) => {
    const jobId = `mix_job_${Date.now()}`;
    jobs[jobId] = { status: 'pending', progress: '0%' };
    res.json({ success: true, jobId: jobId });

    setImmediate(async () => {
        const narrationFile = req.file;
        const { images, imageDuration, transition } = req.body;
        let allTempFiles = [];
        if (narrationFile) allTempFiles.push(narrationFile.path);

        try {
            jobs[jobId].status = 'processing';
            jobs[jobId].progress = '10%';

            if (!narrationFile || !images) throw new Error("Narração e Imagens são obrigatórias.");

            // Parse imagens (pode ser JSON string de Base64)
            let imageList = [];
            try {
                imageList = JSON.parse(images);
            } catch (e) {
                throw new Error("Formato de imagens inválido. Deve ser JSON Array.");
            }

            // Salvar imagens em disco
            const imagePaths = [];
            for (let i = 0; i < imageList.length; i++) {
                const imgData = imageList[i];
                const imgPath = path.join(uploadDir, `temp-img-${jobId}-${i}.png`);
                allTempFiles.push(imgPath);
                
                if (imgData.startsWith('data:')) {
                    // Base64
                    const base64Data = imgData.replace(/^data:image\/\w+;base64,/, "");
                    fs.writeFileSync(imgPath, base64Data, 'base64');
                } else {
                    // URL (Mock ou externo) - tenta baixar
                    const resp = await fetch(imgData);
                    const buffer = await resp.buffer();
                    fs.writeFileSync(imgPath, buffer);
                }
                imagePaths.push(imgPath);
            }

            jobs[jobId].progress = '40%';

            // Calcular duração
            const audioDuration = await getMediaDuration(narrationFile.path);
            let durationPerImg = parseFloat(imageDuration);
            if (isNaN(durationPerImg) || durationPerImg <= 0) {
                durationPerImg = audioDuration / imagePaths.length;
            }

            // Criar lista para concat
            const fileListPath = path.join(uploadDir, `list-${jobId}.txt`);
            allTempFiles.push(fileListPath);
            
            // Lógica complexa de filtro para slideshow (Ken Burns / Fade)
            // Para simplificar e garantir robustez, vamos criar clips individuais e concatenar
            // Ou usar concat demuxer se não houver transições complexas
            
            const clips = [];
            const width = 1920;
            const height = 1080;

            for(let i=0; i<imagePaths.length; i++) {
                const p = imagePaths[i];
                const clipPath = path.join(processedDir, `clip-${jobId}-${i}.mp4`);
                allTempFiles.push(clipPath);
                
                // Cria vídeo a partir da imagem
                // Padroniza tamanho, aplica duração e framerate
                const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
                
                await runFFmpeg(`ffmpeg -loop 1 -i "${p}" -c:v libx264 -t ${durationPerImg} -pix_fmt yuv420p -vf "${filter}" -r 30 -y "${clipPath}"`);
                clips.push(clipPath);
                jobs[jobId].progress = `${40 + Math.round(40 * ((i+1)/imagePaths.length))}%`;
            }

            // Unir clips
            const concatListContent = clips.map(c => `file '${c}'`).join('\n');
            fs.writeFileSync(fileListPath, concatListContent);
            
            const silentVideoPath = path.join(processedDir, `silent-${jobId}.mp4`);
            allTempFiles.push(silentVideoPath);
            
            // Concatena
            await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy -y "${silentVideoPath}"`);

            // Adiciona Áudio
            const finalOutputPath = path.join(processedDir, `final-${jobId}.mp4`);
            
            // Faz o mix final (ajusta duração do vídeo ao áudio ou vice versa)
            // -shortest garante que o vídeo acabe quando o áudio acabar (ou imagem, o que for mais curto)
            await runFFmpeg(`ffmpeg -i "${silentVideoPath}" -i "${narrationFile.path}" -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest -y "${finalOutputPath}"`);

            jobs[jobId].status = 'completed';
            jobs[jobId].progress = '100%';
            jobs[jobId].result = { isFilePath: true, data: finalOutputPath };

        } catch (e) {
            console.error(`Job ${jobId} failed:`, e);
            jobs[jobId] = { status: 'failed', error: e.message };
            safeDeleteFiles(allTempFiles);
        }
    });
});

// --- INTEGRAÇÕES DE API (Proxies) ---

// Replicate (SFX/Music)
app.post('/generate-audio-replicate', async (req, res) => {
    const { prompt, type, apiKey } = req.body; // Recebe API Key do frontend se enviada
    
    // Usa a do frontend ou a do env
    const key = apiKey || process.env.REPLICATE_API_KEY; 
    if(!key) return res.status(400).json({error: "API Key necessária"});

    try {
        const modelVersion = type === 'music' 
            ? "b05b1dff1d8c6dc63d14b0cdb42135378dcb87f6373b0d3d341ede46e59e2b38" // MusicGen
            : "b71bba26d69787bb772e76a7f9f3c327f73838c699290027360f302243f09647"; // AudioLDM-2

        // 1. Start Prediction
        const start = await fetch("https://api.replicate.com/v1/predictions", {
            method: "POST",
            headers: { "Authorization": `Token ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                version: modelVersion,
                input: { prompt: prompt, duration: 10 }
            })
        });
        
        const jsonStart = await start.json();
        if(jsonStart.error) throw new Error(jsonStart.error);
        
        const getUrl = jsonStart.urls.get;
        let output = null;

        // 2. Poll for result
        while(!output) {
            await new Promise(r => setTimeout(r, 2000));
            const check = await fetch(getUrl, { headers: { "Authorization": `Token ${key}` } });
            const jsonCheck = await check.json();
            if(jsonCheck.status === 'succeeded') output = jsonCheck.output;
            else if(jsonCheck.status === 'failed') throw new Error("Replicate failed");
        }

        res.json({ audio: output });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Clonagem ElevenLabs (Proxy para evitar CORS se necessário, mas o frontend já faz direto)
// Mantido para compatibilidade
app.post('/clonar-voz', upload.single('audio'), async (req, res) => {
    res.status(501).send("Use a integração direta no frontend.");
});

// Iniciar
app.listen(PORT, () => {
    console.log(`Servidor a correr na porta ${PORT}`);
});
