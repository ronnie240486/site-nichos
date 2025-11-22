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

// Objeto para guardar o estado dos trabalhos em background
const jobs = {};

const uploadDir = path.join(__dirname, 'uploads');
const processedDir = path.join(__dirname, 'processed');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir);

// 3. Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
// IMPORTANTE: Servir ficheiros estáticos para que APIs externas possam ler os uploads
app.use('/downloads', express.static(processedDir));
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}-${safeOriginalName}`);
    }
});

// Configuração relaxada do Multer (Aceita qualquer ficheiro de qualquer campo)
const upload = multer({ storage: storage });

// 4. Funções Auxiliares
function runFFmpeg(command) {
    return new Promise((resolve, reject) => {
        console.log(`Executando FFmpeg: ${command}`);
        exec(command, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`FFmpeg Stderr: ${stderr}`);
                return reject(new Error(`Erro no FFmpeg: ${stderr || 'Erro desconhecido'}`));
            }
            resolve();
        });
    });
}

function getMediaDuration(filePath) {
    return new Promise((resolve, reject) => {
        const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
        exec(command, (error, stdout, stderr) => {
            if (error) {
                return reject(new Error(`Erro no ffprobe: ${stderr}`));
            }
            resolve(parseFloat(stdout));
        });
    });
}

function safeDeleteFiles(files) {
    files.forEach(f => {
        if (f && fs.existsSync(f)) {
            try {
                fs.unlinkSync(f);
                console.log(`Ficheiro temporário removido: ${f}`);
            } catch (e) {
                console.error(`Erro ao deletar ${f}:`, e);
            }
        }
    });
}

function getEffectFilter(transition, duration, dValue, width, height) {
    switch (transition) {
        case 'frei0r.filter.blackwhite': return `frei0r=filter_name=blackwhite`;
        default: // Efeito Ken Burns
            return `zoompan=z='min(zoom+0.001,1.1)':d=${dValue}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
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

// 5. Rotas
app.get('/', (req, res) => res.send('Backend DarkMaker está a funcionar!'));
app.get('/status', (req, res) => res.status(200).send('Servidor pronto.'));

// --- ROTAS DE ESTADO (JOBS) ---
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

// --- ROTA CRÍTICA: WORKFLOW MÁGICO ---
app.post('/workflow-magico', upload.any(), async (req, res) => {
    const { topic, settings: settingsStr } = req.body;
    let settings = {};
    try {
        settings = JSON.parse(settingsStr);
    } catch (e) {
        return res.status(400).send("Configurações inválidas.");
    }

    let allTempFiles = [];
    
    // Mapeamento manual dos ficheiros (porque usamos upload.any())
    const logoFile = req.files ? req.files.find(f => f.fieldname === 'logo') : null;
    const introFile = req.files ? req.files.find(f => f.fieldname === 'intro') : null;
    const outroFile = req.files ? req.files.find(f => f.fieldname === 'outro') : null;

    try {
        if(logoFile) allTempFiles.push(logoFile.path);
        if(introFile) allTempFiles.push(introFile.path);
        if(outroFile) allTempFiles.push(outroFile.path);

        const geminiApiKey = req.headers['x-gemini-api-key'];
        const pexelsApiKey = req.headers['x-pexels-api-key'];
        const stabilityApiKey = req.headers['x-stability-api-key'];
        const openaiApiKey = req.headers['x-openai-api-key'];

        if (!geminiApiKey || !pexelsApiKey || !stabilityApiKey || !openaiApiKey) {
            throw new Error("Todas as chaves de API (Gemini, Pexels, Stability, OpenAI) são necessárias.");
        }

        console.log(`[Workflow Avançado] Iniciado para o tópico: "${topic}"`);

        // 1. Gerar Roteiro
        console.log("[Workflow] Etapa 1/8: A gerar roteiro...");
        const scriptPrompt = `Crie um roteiro para um vídeo curto (40-60 segundos) sobre "${topic}". O roteiro deve ser envolvente, informativo e dividido em frases curtas. Responda APENAS com o texto do roteiro.`;
        const scriptResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${geminiApiKey}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: scriptPrompt }] }] })
        });
        if (!scriptResponse.ok) throw new Error("Falha ao gerar o roteiro.");
        const scriptData = await scriptResponse.json();
        const script = scriptData.candidates[0].content.parts[0].text.trim();

        // 2. Gerar Narração
        console.log("[Workflow] Etapa 2/8: A gerar narração...");
        const narrationResponse = await fetch(`https://api.openai.com/v1/audio/speech`, {
            method: 'POST', headers: { 'Authorization': `Bearer ${openaiApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'tts-1-hd', voice: 'alloy', input: script, response_format: 'mp3' })
        });
        if (!narrationResponse.ok) throw new Error(`Falha ao gerar a narração: ${await narrationResponse.text()}`);
        const narrationBuffer = await narrationResponse.buffer();
        const narrationPath = path.join(uploadDir, `narration-${Date.now()}.mp3`);
        fs.writeFileSync(narrationPath, narrationBuffer);
        allTempFiles.push(narrationPath);

        // 3. Analisar Cenas
        console.log("[Workflow] Etapa 3/8: A analisar cenas...");
        const scenesPrompt = `Analise este roteiro e divida-o em 5 a 8 cenas visuais. Para cada cena, forneça um termo de busca conciso e em inglês para encontrar um vídeo de stock. Retorne um array de objetos JSON. Exemplo: [{"cena": 1, "termo_busca": "person meditating peacefully"}, ...]. Roteiro: "${script}"`;
        const scenesResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${geminiApiKey}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: scenesPrompt }] }], generationConfig: { responseMimeType: "application/json" } })
        });
        if (!scenesResponse.ok) throw new Error("Falha ao analisar as cenas.");
        const scenesData = await scenesResponse.json();
        const scenes = JSON.parse(scenesData.candidates[0].content.parts[0].text);

        // 4. Busca de Mídia
        console.log("[Workflow] Etapa 4/8: A buscar mídias...");
        const downloadPromises = scenes.map(async (scene) => {
            const pexelsResponse = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(scene.termo_busca)}&per_page=1&orientation=landscape`, { headers: { 'Authorization': pexelsApiKey } });
            const pexelsData = await pexelsResponse.json();
            const videoUrl = pexelsData.videos?.[0]?.video_files?.find(f => f.quality === 'hd')?.link;
            
            if (videoUrl) {
                const videoPath = path.join(uploadDir, `scene-${scene.cena}.mp4`);
                const videoRes = await fetch(videoUrl);
                const fileStream = fs.createWriteStream(videoPath);
                await new Promise((resolve, reject) => { videoRes.body.pipe(fileStream); videoRes.body.on("error", reject); fileStream.on("finish", resolve); });
                return videoPath;
            } else {
                // Fallback para imagem IA
                const stabilityResponse = await fetch("https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${stabilityApiKey}` },
                    body: JSON.stringify({ text_prompts: [{ text: `${scene.termo_busca}, cinematic, high detail` }], steps: 30, width: 1920, height: 1080 })
                });
                if (!stabilityResponse.ok) return null;
                const stabilityData = await stabilityResponse.json();
                const imageBase64 = stabilityData.artifacts[0].base64;
                const imagePath = path.join(uploadDir, `scene-img-${scene.cena}.png`);
                fs.writeFileSync(imagePath, Buffer.from(imageBase64, 'base64'));
                allTempFiles.push(imagePath);
                
                const videoPath = path.join(uploadDir, `scene-vid-${scene.cena}.mp4`);
                const kenburnsEffect = settings.kenburns ? `,zoompan=z='min(zoom+0.001,1.1)':d=125:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'` : '';
                await runFFmpeg(`ffmpeg -loop 1 -i "${imagePath}" -c:v libx264 -t 5 -pix_fmt yuv420p -vf "scale=1920:1080${kenburnsEffect}" -y "${videoPath}"`);
                return videoPath;
            }
        });
        const mediaPaths = (await Promise.all(downloadPromises)).filter(Boolean);
        allTempFiles.push(...mediaPaths);
        if (mediaPaths.length === 0) throw new Error("Nenhuma mídia pôde ser encontrada ou gerada.");

        // 5. Montagem
        console.log("[Workflow] Etapa 5/8: A montar o vídeo...");
        const [width, height] = settings.format === '9:16' ? [1080, 1920] : [1920, 1080];
        let filterComplex = '';
        mediaPaths.forEach((p, i) => {
            filterComplex += `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}];`;
        });

        let lastVideoOutput;
        if (mediaPaths.length > 1) {
            for (let i = 0; i < mediaPaths.length - 1; i++) {
                const input1 = i === 0 ? `[v${i}]` : `[vt${i-1}]`;
                const input2 = `[v${i+1}]`;
                const output = `[vt${i}]`;
                filterComplex += `${input1}${input2}xfade=transition=${settings.transition}:duration=1:offset=${(i+1)*4}${output};`;
            }
            lastVideoOutput = `[vt${mediaPaths.length - 2}]`;
        } else {
            lastVideoOutput = '[v0]';
        }

        const silentVideoPath = path.join(processedDir, `silent_complex-${Date.now()}.mp4`);
        allTempFiles.push(silentVideoPath);
        
        const ffmpegInputs = mediaPaths.map(p => `-i "${p}"`).join(' ');
        const finalMap = lastVideoOutput.includes('[') ? `-map "${lastVideoOutput}"` : `-map "[v0]"`;
        await runFFmpeg(`ffmpeg ${ffmpegInputs} -filter_complex "${filterComplex}" ${finalMap} -c:v libx264 -preset ultrafast -pix_fmt yuv420p -y "${silentVideoPath}"`);

        // 6. Adicionar Áudio
        console.log("[Workflow] Etapa 6/8: A adicionar áudio...");
        const audioVideoPath = path.join(processedDir, `audio-video-${Date.now()}.mp4`);
        allTempFiles.push(audioVideoPath);
        await runFFmpeg(`ffmpeg -i "${silentVideoPath}" -i "${narrationPath}" -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest -y "${audioVideoPath}"`);

        // 7. Intro/Outro
        let finalVideoPath = audioVideoPath;
        if(introFile || outroFile) {
            console.log("[Workflow] Etapa 7/8: A adicionar Intro/Outro...");
            const concatList = [];
            if(introFile) concatList.push(`file '${introFile.path.replace(/'/g, "'\\''")}'`);
            concatList.push(`file '${audioVideoPath.replace(/'/g, "'\\''")}'`);
            if(outroFile) concatList.push(`file '${outroFile.path.replace(/'/g, "'\\''")}'`);

            const concatFilePath = path.join(uploadDir, `concat-list-${Date.now()}.txt`);
            fs.writeFileSync(concatFilePath, concatList.join('\n'));
            allTempFiles.push(concatFilePath);

            const finalConcatPath = path.join(processedDir, `final-concat-${Date.now()}.mp4`);
            await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${concatFilePath}" -c copy -y "${finalConcatPath}"`);
            finalVideoPath = finalConcatPath;
        }

        // 8. Conteúdo Extra
        const youtubePrompt = `Gere 3 títulos e uma descrição para YouTube sobre: "${topic}". Retorne JSON com keys "titles" e "description".`;
        const youtubeResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${geminiApiKey}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: youtubePrompt }] }], generationConfig: { responseMimeType: "application/json" } })
        });
        const youtubeData = await youtubeResponse.json();
        const youtubeContent = JSON.parse(youtubeData.candidates[0].content.parts[0].text);

        const videoDataUrl = `data:video/mp4;base64,${fs.readFileSync(finalVideoPath).toString('base64')}`;
        
        res.json({
            videoDataUrl: videoDataUrl,
            thumbnails: [],
            youtubeContent: youtubeContent
        });

    } catch (error) {
        console.error('Erro no Workflow Mágico Avançado:', error);
        safeDeleteFiles(allTempFiles);
        if (!res.headersSent) {
            res.status(500).send(`Erro interno no Workflow Mágico: ${error.message}`);
        }
    }
});

// --- ROTAS DO IA TURBO (ASSÍNCRONAS E COM UPLOAD.ANY) ---

app.post('/extrair-audio', upload.any(), (req, res) => {
    const jobId = `audio_job_${Date.now()}`;
    jobs[jobId] = { status: 'pending' };
    res.json({ success: true, jobId: jobId });

    setImmediate(async () => {
        let videoPath = null;
        let allTempFiles = [];
        const file = req.files ? req.files.find(f => f.fieldname === 'video' || f.fieldname === 'videos') || req.files[0] : null;
        if (file) allTempFiles.push(file.path);

        try {
            jobs[jobId].status = 'processing';
            if (file) {
                videoPath = file.path;
            } else if (req.body.url) {
                const videoUrl = req.body.url;
                videoPath = path.join(uploadDir, `download_audio_${jobId}.mp4`);
                allTempFiles.push(videoPath);
                await youtubedl.exec(videoUrl, { output: videoPath, format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best' });
            } else {
                throw new Error('Nenhum ficheiro ou URL enviado.');
            }

            const outputPath = path.join(processedDir, `audio-ext-${jobId}.wav`);
            allTempFiles.push(outputPath);
            await runFFmpeg(`ffmpeg -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 -y "${outputPath}"`);
            
            jobs[jobId] = { status: 'completed', result: { isFilePath: true, data: outputPath } };
            safeDeleteFiles(allTempFiles.filter(f => f !== outputPath));

        } catch (e) {
            console.error(`[Job ${jobId}] Erro: ${e.message}`);
            jobs[jobId] = { status: 'failed', error: e.message };
            safeDeleteFiles(allTempFiles);
        }
    });
});

app.post('/transcrever-audio', upload.any(), (req, res) => {
    const jobId = `transcribe_job_${Date.now()}`;
    jobs[jobId] = { status: 'pending' };
    res.json({ success: true, jobId: jobId });

    setImmediate(async () => {
        const audioFile = req.files ? req.files.find(f => f.fieldname === 'audio') || req.files[0] : null;
        const { googleCreds, languageCode = 'pt-BR' } = req.body;
        const allTempFiles = [];
        if (audioFile) allTempFiles.push(audioFile.path);

        try {
            if (!audioFile || !googleCreds) throw new Error('Dados insuficientes.');
            jobs[jobId].status = 'processing';
            
            let creds;
            try { creds = JSON.parse(googleCreds); } 
            catch (jsonError) { throw new Error("Credenciais inválidas."); }
            
            const tempCredsPath = path.join(uploadDir, `creds-${jobId}.json`);
            fs.writeFileSync(tempCredsPath, JSON.stringify(creds));
            allTempFiles.push(tempCredsPath);

            const speechClient = new SpeechClient({ keyFilename: tempCredsPath });
            const audioBytes = fs.readFileSync(audioFile.path).toString('base64');
            const request = { 
                audio: { content: audioBytes }, 
                config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: languageCode, model: 'default' }, 
            };
            const [response] = await speechClient.recognize(request);
            const transcription = response.results.map(result => result.alternatives[0].transcript).join('\n');
            
            jobs[jobId] = { status: 'completed', result: { isFilePath: false, data: { script: transcription } } };
        } catch (e) {
            jobs[jobId] = { status: 'failed', error: e.message };
        } finally {
            safeDeleteFiles(allTempFiles);
        }
    });
});

app.post('/extrair-frames', upload.any(), (req, res) => {
    const jobId = `frames_job_${Date.now()}`;
    jobs[jobId] = { status: 'pending' };
    res.json({ success: true, jobId: jobId });

    setImmediate(async () => {
        let videoPath = null;
        let allTempFiles = [];
        const file = req.files ? req.files.find(f => f.fieldname === 'video') || req.files[0] : null;
        if (file) allTempFiles.push(file.path);

        try {
            jobs[jobId].status = 'processing';
            if (file) {
                videoPath = file.path;
            } else if (req.body.url) {
                const videoUrl = req.body.url;
                videoPath = path.join(uploadDir, `download_frames_${jobId}.mp4`);
                allTempFiles.push(videoPath);
                await youtubedl.exec(videoUrl, { output: videoPath, format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best' });
            } else {
                throw new Error('Nenhum ficheiro ou URL enviado.');
            }

            const uniquePrefix = `frame-${jobId}`;
            const outputPattern = path.join(processedDir, `${uniquePrefix}-%03d.png`);
            const sceneDetectionThreshold = 0.4;
            await runFFmpeg(`ffmpeg -i "${videoPath}" -vf "select='gt(scene,${sceneDetectionThreshold})'" -vsync vfr -y "${outputPattern}"`);
            
            let frameFiles = fs.readdirSync(processedDir).filter(f => f.startsWith(uniquePrefix));
            allTempFiles.push(...frameFiles.map(f => path.join(processedDir, f)));

            if (frameFiles.length === 0) {
                 await runFFmpeg(`ffmpeg -i "${videoPath}" -vf fps=1/5 -y "${outputPattern}"`);
                 frameFiles = fs.readdirSync(processedDir).filter(f => f.startsWith(uniquePrefix));
                 allTempFiles.push(...frameFiles.map(f => path.join(processedDir, f)));
            }

            const base64Frames = frameFiles.map(frameFile => {
                const framePath = path.join(processedDir, frameFile);
                const bitmap = fs.readFileSync(framePath);
                return `data:image/png;base64,${Buffer.from(bitmap).toString('base64')}`;
            });
            jobs[jobId] = { status: 'completed', result: { isFilePath: false, data: { frames: base64Frames } } };
        } catch (e) {
            jobs[jobId] = { status: 'failed', error: e.message };
        } finally {
            safeDeleteFiles(allTempFiles);
        }
    });
});

// Função de mixagem reutilizável
const handleVideoMixingJob = (req, res) => {
    const jobId = `mix_job_${Date.now()}`;
    jobs[jobId] = { status: 'pending', progress: '0%' };
    res.json({ success: true, jobId: jobId });

    setImmediate(async () => {
        const narrationFile = req.files ? req.files.find(f => f.fieldname === 'narration') : null;
        const { images, script, imageDuration, videoType, blockSize, transition } = req.body;
        let allTempFiles = [];
        if (narrationFile) allTempFiles.push(narrationFile.path);

        try {
            if (!narrationFile || !images || !script) throw new Error('Dados insuficientes.');
            jobs[jobId].status = 'processing';
            jobs[jobId].progress = '10%';

            const imageArray = JSON.parse(images);
            const scriptLines = script.split(/\r?\n/).filter(l => l.trim() !== '');
            
            const videoWidth = videoType === 'short' ? 1080 : 1920;
            const videoHeight = videoType === 'short' ? 1920 : 1080;
            
            // Lógica simplificada de mixagem
            const blockVideoPaths = [];
            for (let i = 0; i < imageArray.length; i++) {
                 const dataUrl = imageArray[i];
                 const base64Data = dataUrl.replace(/^data:image\/(png|jpeg|webp);base64,/, "");
                 const imagePath = path.join(uploadDir, `frame_${jobId}_${i}.png`);
                 fs.writeFileSync(imagePath, base64Data, 'base64');
                 allTempFiles.push(imagePath);

                 const chunkPath = path.join(processedDir, `chunk_${jobId}_${i}.mp4`);
                 allTempFiles.push(chunkPath);
                 
                 // Duração fixa por imagem por agora (para simplificar)
                 const dur = 5; 
                 await runFFmpeg(`ffmpeg -loop 1 -i "${imagePath}" -c:v libx264 -t ${dur} -pix_fmt yuv420p -vf "scale=${videoWidth}:${videoHeight}:force_original_aspect_ratio=decrease,pad=${videoWidth}:${videoHeight}:-1:-1,setsar=1" -y "${chunkPath}"`);
                 blockVideoPaths.push(chunkPath);
            }

            const finalListPath = path.join(uploadDir, `list-${jobId}.txt`);
            const fileContent = blockVideoPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
            fs.writeFileSync(finalListPath, fileContent);
            allTempFiles.push(finalListPath);

            const finalSilentPath = path.join(processedDir, `silent-${jobId}.mp4`);
            allTempFiles.push(finalSilentPath);
            await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${finalListPath}" -c copy -y "${finalSilentPath}"`);

            const outputPath = path.join(processedDir, `video-final-${jobId}.mp4`);
            await runFFmpeg(`ffmpeg -i "${finalSilentPath}" -i "${narrationFile.path}" -c:v copy -c:a aac -shortest -y "${outputPath}"`);

            jobs[jobId] = { 
                status: 'completed', 
                progress: '100%',
                result: { isFilePath: true, data: outputPath } 
            };
            
        } catch (e) {
            jobs[jobId] = { status: 'failed', error: e.message };
        } finally {
            if (jobs[jobId]?.status === 'failed') safeDeleteFiles(allTempFiles);
        }
    });
};

app.post('/mixar-video-turbo-advanced', upload.any(), handleVideoMixingJob);
app.post('/criar-video-automatico', upload.any(), handleVideoMixingJob);

// --- ROTAS GERAIS (upload.any() para evitar MulterError) ---

app.post('/cortar-video', upload.any(), async (req, res) => {
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

app.post('/unir-videos', upload.any(), async (req, res) => {
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

app.post('/comprimir-videos', upload.any(), async (req, res) => {
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

app.post('/embaralhar-videos', upload.any(), async (req, res) => {
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

app.post('/remover-audio', upload.any(), async (req, res) => {
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

// Ferramentas de Áudio
app.post('/unir-audio', upload.any(), async (req, res) => {
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

app.post('/limpar-metadados-audio', upload.any(), async (req, res) => {
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

app.post('/embaralhar-audio', upload.any(), async (req, res) => {
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

app.post('/melhorar-audio', upload.any(), async (req, res) => {
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

app.post('/remover-silencio', upload.any(), async (req, res) => {
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

app.post('/render-timeline', upload.any(), async (req, res) => {
    const { payload } = req.body;
    const mediaFiles = req.files ? req.files.filter(f => f.fieldname === 'media') : [];
    const audioFile = req.files ? req.files.find(f => f.fieldname === 'audio') : null;
    
    if (!payload || mediaFiles.length === 0) {
        return res.status(400).send('Dados da timeline ou ficheiros em falta.');
    }

    let allTempFiles = mediaFiles.map(f => f.path);
    if (audioFile) allTempFiles.push(audioFile.path);
    
    try {
        const data = JSON.parse(payload);
        const { clips, settings } = data;

        const filesByName = mediaFiles.reduce((acc, file) => {
            acc[file.originalname] = file.path;
            return acc;
        }, {});
        const orderedFilePaths = clips.map(clip => filesByName[clip.originalName]);

        const videoClips = [];

        for (let i = 0; i < orderedFilePaths.length; i++) {
            const filePath = orderedFilePaths[i];
            const clipInfo = clips[i];
            
            if (clipInfo.type === 'image') {
                const outputPath = path.join(processedDir, `clip-${i}.mp4`);
                allTempFiles.push(outputPath);
                const command = `ffmpeg -loop 1 -i "${filePath}" -c:v libx264 -t 5 -pix_fmt yuv420p -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1" -y "${outputPath}"`;
                await runFFmpeg(command);
                videoClips.push(outputPath);
            } else {
                const outputPath = path.join(processedDir, `clip-${i}.mp4`);
                allTempFiles.push(outputPath);
                const command = `ffmpeg -i "${filePath}" -c:v libx264 -pix_fmt yuv420p -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1" -an -y "${outputPath}"`;
                await runFFmpeg(command);
                videoClips.push(outputPath);
            }
        }

        const silentVideoPath = path.join(processedDir, `timeline-silent-${Date.now()}.mp4`);
        allTempFiles.push(silentVideoPath);
        
        if (videoClips.length === 1) {
            fs.renameSync(videoClips[0], silentVideoPath);
        } else {
            const inputs = videoClips.map(p => `-i "${p}"`).join(' ');
            let filterComplex = '';
            videoClips.forEach((p, i) => { filterComplex += `[${i}:v]settb=1/25,fps=25[v${i}];`; });
            for (let i = 0; i < videoClips.length - 1; i++) {
                const input1 = i === 0 ? `[v${i}]` : `[vt${i-1}]`;
                const input2 = `[v${i+1}]`;
                const output = `[vt${i}]`;
                filterComplex += `${input1}${input2}xfade=transition=${settings.transition || 'fade'}:duration=1:offset=${(i+1)*5 - 1}${output};`;
            }
            const lastOutput = `[vt${videoClips.length - 2}]`;
            await runFFmpeg(`ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "${lastOutput}" -c:v libx264 -pix_fmt yuv420p -y "${silentVideoPath}"`);
        }
        
        let finalVideoPath = silentVideoPath;
        let finalOutputPath = path.join(processedDir, `timeline-final-${Date.now()}.mp4`);
        allTempFiles.push(finalOutputPath);

        let command = `ffmpeg -i "${silentVideoPath}"`;
        let audioMap = "-map 0:v:0";
        let audioCodec = "-c:v copy";

        if (audioFile) {
            command += ` -i "${audioFile.path}"`;
            audioMap += " -map 1:a:0";
            audioCodec += " -c:a aac -shortest";
        }
        
        if (settings.subtitles) {
            const srtPath = path.join(uploadDir, `subtitles-${Date.now()}.srt`);
            allTempFiles.push(srtPath);
            fs.writeFileSync(srtPath, `1\n00:00:00,000 --> 00:10:00,000\n${settings.subtitles}`);
            command += ` -vf "subtitles='${srtPath.replace(/\\/g, '/')}'"`;
        }

        command += ` ${audioMap} ${audioCodec} -y "${finalOutputPath}"`;
        await runFFmpeg(command);
        finalVideoPath = finalOutputPath;

        res.sendFile(finalVideoPath, (err) => {
            if (err) console.error('Erro ao enviar vídeo:', err);
            safeDeleteFiles(allTempFiles);
        });

    } catch (error) {
        console.error('Erro em /render-timeline:', error);
        safeDeleteFiles(allTempFiles);
        if (!res.headersSent) {
            res.status(500).send(`Erro ao processar a timeline: ${error.message}`);
        }
    }
});

app.post('/gerar-musica', upload.any(), async (req, res) => {
    const allTempFiles = (req.files || []).map(f => f.path);
    try {
        const { descricao } = req.body;
        const replicateApiKey = req.headers['x-replicate-api-key']; 
        if (!descricao) { return res.status(400).send('A descrição da música é obrigatória.'); }
        if (!replicateApiKey) { return res.status(400).send('A chave da API da Replicate não foi fornecida.'); }
        console.log(`Iniciando geração de música para: "${descricao}"`);
        const startResponse = await fetch("https://api.replicate.com/v1/predictions", {
            method: "POST", headers: { "Authorization": `Token ${replicateApiKey}`, "Content-Type": "application/json", },
            body: JSON.stringify({ version: "8cf61ea6c56afd61d8f5b9ffd14d7c216c0a93844ce2d82ac1c9ecc9c7f24e05", input: { model_version: "stereo-large", prompt: descricao, duration: 10 }, }),
        });
        const prediction = await startResponse.json();
        if (startResponse.status !== 201) { throw new Error(prediction.detail || "Falha ao iniciar a geração na Replicate."); }
        let predictionUrl = prediction.urls.get;
        let generatedMusicUrl = null;
        while (!generatedMusicUrl) {
            console.log("A verificar o estado da geração...");
            await new Promise(resolve => setTimeout(resolve, 3000)); 
            const statusResponse = await fetch(predictionUrl, { headers: { "Authorization": `Token ${replicateApiKey}` }, });
            const statusResult = await statusResponse.json();
            if (statusResult.status === "succeeded") { generatedMusicUrl = statusResult.output; break; } 
            else if (statusResult.status === "failed") { throw new Error("A geração da música falhou na Replicate."); }
        }
        console.log("Música gerada com sucesso:", generatedMusicUrl);
        const musicResponse = await fetch(generatedMusicUrl);
        if (!musicResponse.ok) { throw new Error("Falha ao fazer o download da música gerada."); }
        res.setHeader('Content-Type', 'audio/mpeg');
        musicResponse.body.pipe(res);
    } catch (error) {
        console.error('Erro ao gerar música:', error);
        safeDeleteFiles(allTempFiles);
        if (!res.headersSent) { res.status(500).send(`Erro interno ao gerar a música: ${error.message}`); }
    }
});

app.post('/separar-faixas', upload.any(), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) { return res.status(400).send('Nenhum ficheiro de áudio enviado.'); }
    const allTempFiles = files.map(f => f.path);
    try {
        for (const file of files) { console.log(`Processando separação de faixas para: ${file.filename}`); }
        console.log("Faixas separadas com sucesso (simulação).");
        safeDeleteFiles(allTempFiles);
        res.status(501).send("Lógica de separação de faixas ainda não implementada no backend.");
    } catch (error) {
        console.error('Erro ao separar faixas:', error);
        safeDeleteFiles(allTempFiles);
        res.status(500).send('Erro interno ao separar as faixas.');
    }
});

app.post('/clonar-voz', upload.any(), async (req, res) => {
    const audioFile = req.files ? req.files.find(f => f.fieldname === 'audio') : null;
    const { text } = req.body;
    const allTempFiles = [audioFile?.path].filter(Boolean);
    if (!audioFile || !text) { safeDeleteFiles(allTempFiles); return res.status(400).send('Faltam a amostra de áudio ou o texto.'); }
    try {
        const elevenlabsApiKey = process.env.ELEVENLABS_API_KEY || req.headers['x-elevenlabs-api-key'];
        if (!elevenlabsApiKey) { throw new Error("A chave da API da ElevenLabs não está configurada."); }
        console.log("Iniciando processo de clonagem de voz...");
        const formData = new FormData();
        formData.append('name', `VozClonada_${Date.now()}`);
        formData.append('files', fs.createReadStream(audioFile.path), audioFile.originalname);
        const addVoiceResponse = await fetch("https://api.elevenlabs.io/v1/voices/add", { method: 'POST', headers: { 'xi-api-key': elevenlabsApiKey }, body: formData, });
        if (!addVoiceResponse.ok) throw new Error(`API da ElevenLabs (Add Voice) retornou um erro: ${await addVoiceResponse.text()}`);
        const { voice_id } = await addVoiceResponse.json();
        const ttsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id}/stream`, {
            method: 'POST', headers: { 'xi-api-key': elevenlabsApiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
        });
        if (!ttsResponse.ok) throw new Error(`API da ElevenLabs (TTS) retornou um erro: ${await ttsResponse.text()}`);
        res.setHeader('Content-Type', 'audio/mpeg');
        ttsResponse.body.pipe(res);
        res.on('finish', async () => {
            await fetch(`https://api.elevenlabs.io/v1/voices/${voice_id}`, { method: 'DELETE', headers: { 'xi-api-key': elevenlabsApiKey } });
            safeDeleteFiles(allTempFiles);
        });
    } catch (error) {
        console.error('Erro no processo de clonagem de voz:', error);
        safeDeleteFiles(allTempFiles);
        if (!res.headersSent) res.status(500).send(`Erro interno na clonagem de voz: ${error.message}`);
    }
});

app.post('/clonar-voz-replicate', upload.any(), async (req, res) => {
    const audioFile = req.files ? req.files.find(f => f.fieldname === 'audio') : null;
    const { text } = req.body;
    const allTempFiles = [audioFile?.path].filter(Boolean);
    if (!audioFile || !text) { safeDeleteFiles(allTempFiles); return res.status(400).send('Faltam a amostra de áudio ou o texto.'); }
    try {
        const replicateApiKey = req.headers['x-replicate-api-key'];
        if (!replicateApiKey) { throw new Error("A chave da API da Replicate não foi fornecida."); }
        const audioBuffer = fs.readFileSync(audioFile.path);
        const base64Audio = audioBuffer.toString('base64');
        const mimeType = audioFile.mimetype; 
        const dataUri = `data:${mimeType};base64,${base64Audio}`;
        const startResponse = await fetch("https://api.replicate.com/v1/predictions", {
            method: "POST", headers: { "Authorization": `Token ${replicateApiKey}`, "Content-Type": "application/json", },
            body: JSON.stringify({ version: "684bc3855b0f59760d8e099d3a4c56c2940a023025887456707334c718112099", input: { text: text, speaker: dataUri, language: "pt" }, }),
        });
        const prediction = await startResponse.json();
        if (startResponse.status !== 201) { throw new Error(prediction.detail || "Falha ao iniciar a clonagem na Replicate."); }
        let predictionUrl = prediction.urls.get;
        let generatedAudioUrl = null;
        while (!generatedAudioUrl) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            const statusResponse = await fetch(predictionUrl, { headers: { "Authorization": `Token ${replicateApiKey}` }, });
            const statusResult = await statusResponse.json();
            if (statusResult.status === "succeeded") { generatedAudioUrl = statusResult.output; break; } 
            else if (statusResult.status === "failed") { throw new Error("A clonagem falhou na Replicate."); }
        }
        const audioResponse = await fetch(generatedAudioUrl);
        if (!audioResponse.ok) throw new Error("Falha ao descarregar o áudio gerado.");
        res.setHeader('Content-Type', 'audio/wav'); 
        audioResponse.body.pipe(res);
        res.on('finish', () => { safeDeleteFiles(allTempFiles); });
    } catch (error) {
        console.error("Erro no Replicate XTTS:", error);
        safeDeleteFiles(allTempFiles);
        if (!res.headersSent) res.status(500).send(`Erro na clonagem Replicate: ${error.message}`);
    }
});

app.post('/gerar-sfx', upload.none(), async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) { return res.status(400).send('A descrição do efeito sonoro é obrigatória.'); }
    try {
        const replicateApiKey = req.headers['x-replicate-api-key'];
        if (!replicateApiKey) { throw new Error("A chave da API da Replicate não foi fornecida."); }
        const startResponse = await fetch("https://api.replicate.com/v1/predictions", {
            method: "POST", headers: { "Authorization": `Token ${replicateApiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ version: "b05b1dff1d8c6ac63d424224fe93a2e79c5689a8b653e7a41da33e5737e4558e", input: { text: prompt, duration: 5 }, }),
        });
        const prediction = await startResponse.json();
        if (startResponse.status !== 201) throw new Error(prediction.detail || "Falha ao iniciar a geração na Replicate.");
        let predictionUrl = prediction.urls.get;
        let generatedSfxUrl = null;
        while (!generatedSfxUrl) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            const statusResponse = await fetch(predictionUrl, { headers: { "Authorization": `Token ${replicateApiKey}` } });
            const statusResult = await statusResponse.json();
            if (statusResult.status === "succeeded") { generatedSfxUrl = statusResult.output; break; } 
            else if (statusResult.status === "failed") { throw new Error("A geração do SFX falhou na Replicate."); }
        }
        const sfxResponse = await fetch(generatedSfxUrl);
        if (!sfxResponse.ok) throw new Error("Falha ao fazer o download do SFX gerado.");
        res.setHeader('Content-Type', 'audio/wav');
        sfxResponse.body.pipe(res);
    } catch (error) {
        if (!res.headersSent) res.status(500).send(`Erro interno ao gerar SFX: ${error.message}`);
    }
});

app.post("/download", async (req, res) => {
  try {
    const { url } = req.body;
    const output = await youtubedl(url, { dumpSingleJson: true, noWarnings: true, preferFreeFormats: true, addHeader: ["referer:youtube.com", "user-agent:googlebot"] });
    res.json({ title: output.title, duration: output.duration, url: url, formats: output.formats });
  } catch (err) {
    res.status(500).json({ error: "Falha ao processar o vídeo" });
  }
});

app.post("/video-info", async (req, res) => {
    try {
        const { url } = req.body;
        const info = await youtubedl(url, { dumpSingleJson: true, noWarnings: true, preferFreeFormats: true, addHeader: ["referer:youtube.com", "user-agent:googlebot"] });
        res.json({ title: info.title, duration: info.duration, uploader: info.uploader, formats: info.formats });
    } catch (err) {
        res.status(500).json({ error: "Falha ao processar o vídeo" });
    }
});

// 6. Iniciar Servidor
app.listen(PORT, () => {
    console.log(`Servidor a correr na porta ${PORT}`);
});
