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
function pcmToWavBuffer(pcmData, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const byteRate = sampleRate * blockAlign;
    const dataSize = pcmData.length;
    
    const buffer = Buffer.alloc(44 + dataSize);
    
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // Subchunk1Size for PCM
    buffer.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    pcmData.copy(buffer, 44);
    
    return buffer;
}

// 5. Rotas
app.get('/', (req, res) => res.send('Backend DarkMaker está a funcionar!'));
app.get('/status', (req, res) => res.status(200).send('Servidor pronto.'));

// --- ROTAS DE FERRAMENTAS GERAIS ---

// Ferramentas de Vídeo
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

// ROTA REAL PARA GERAR MÚSICA COM REPLICATE (ASSÍNCRONA)
app.post('/gerar-musica', upload.array('videos'), async (req, res) => {
    // Limpa ficheiros de upload que não são usados nesta rota
    const allTempFiles = (req.files || []).map(f => f.path);
    
    try {
        const { descricao } = req.body;
        // Pega a chave da API que o frontend envia no cabeçalho
        const replicateApiKey = req.headers['x-replicate-api-key']; 

        if (!descricao) {
            return res.status(400).send('A descrição da música é obrigatória.');
        }
        if (!replicateApiKey) {
            return res.status(400).send('A chave da API da Replicate não foi fornecida.');
        }

        console.log(`Iniciando geração de música para: "${descricao}"`);

        // Etapa 1: Iniciar a predição na Replicate
        const startResponse = await fetch("https://api.replicate.com/v1/predictions", {
            method: "POST",
            headers: {
                "Authorization": `Token ${replicateApiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                // Versão do modelo MusicGen da Meta
                version: "8cf61ea6c56afd61d8f5b9ffd14d7c216c0a93844ce2d82ac1c9ecc9c7f24e05", 
                input: {
                    model_version: "stereo-large",
                    prompt: descricao,
                    duration: 10 // Duração em segundos (pode ajustar)
                },
            }),
        });

        const prediction = await startResponse.json();
        if (startResponse.status !== 201) {
            throw new Error(prediction.detail || "Falha ao iniciar a geração na Replicate.");
        }

        let predictionUrl = prediction.urls.get;
        let generatedMusicUrl = null;

        // Etapa 2: Verificar o estado da predição até estar concluída
        while (!generatedMusicUrl) {
            console.log("A verificar o estado da geração...");
            // Espera 3 segundos entre cada verificação para não sobrecarregar a API
            await new Promise(resolve => setTimeout(resolve, 3000)); 

            const statusResponse = await fetch(predictionUrl, {
                headers: { "Authorization": `Token ${replicateApiKey}` },
            });
            const statusResult = await statusResponse.json();

            if (statusResult.status === "succeeded") {
                generatedMusicUrl = statusResult.output;
                break;
            } else if (statusResult.status === "failed") {
                throw new Error("A geração da música falhou na Replicate.");
            }
            // Se ainda estiver "starting" ou "processing", o loop continua
        }

        console.log("Música gerada com sucesso:", generatedMusicUrl);

        // Etapa 3: Fazer o download da música gerada e enviá-la ao utilizador
        const musicResponse = await fetch(generatedMusicUrl);
        if (!musicResponse.ok) {
            throw new Error("Falha ao fazer o download da música gerada.");
        }

        // Envia o áudio diretamente para o navegador do utilizador
        res.setHeader('Content-Type', 'audio/mpeg');
        musicResponse.body.pipe(res);

    } catch (error) {
        console.error('Erro ao gerar música:', error);
        // Garante que os ficheiros temporários são limpos em caso de erro
        safeDeleteFiles(allTempFiles);
        if (!res.headersSent) {
            res.status(500).send(`Erro interno ao gerar a música: ${error.message}`);
        }
    }
});

app.post('/separar-faixas', upload.array('videos'), async (req, res) => {
    // Usamos 'upload.array('videos')' para manter a consistência com as outras rotas
    const files = req.files || [];
    if (files.length === 0) {
        return res.status(400).send('Nenhum ficheiro de áudio enviado.');
    }

    const allTempFiles = files.map(f => f.path);
    try {
        const processedFiles = [];
        for (const file of files) {
            console.log(`Processando separação de faixas para: ${file.filename}`);

            // ===================================================================
            // AQUI VAI A SUA LÓGICA DE IA PARA SEPARAR AS FAIXAS
            // 1. Use uma ferramenta como Spleeter ou Demucs.
            // 2. Processe o ficheiro de áudio salvo em 'file.path'.
            // 3. O resultado serão vários ficheiros (vocais.mp3, instrumental.mp3, etc.).
            // 4. Adicione os caminhos desses ficheiros a 'processedFiles'.
            // Ex: processedFiles.push({ path: 'caminho/para/vocais.mp3', name: 'vocais.mp3' });
            // ===================================================================
        }

        // Exemplo de resposta (substitua pela lógica real)
        console.log("Faixas separadas com sucesso (simulação).");
        // Quando a lógica estiver pronta, use sendZipResponse para enviar os ficheiros separados
        // sendZipResponse(res, processedFiles, allTempFiles);
        safeDeleteFiles(allTempFiles);
        res.status(501).send("Lógica de separação de faixas ainda não implementada no backend.");

    } catch (error) {
        console.error('Erro ao separar faixas:', error);
        safeDeleteFiles(allTempFiles);
        res.status(500).send('Erro interno ao separar as faixas.');
    }
});

// --- FIM DO CÓDIGO ADICIONADO ---
// ROTA CORRIGIDA PARA GERAR MÚSICA COM REPLICATE (ASSÍNCRONA)
app.post('/gerar-musica', upload.array('videos'), async (req, res) => {
    const allTempFiles = (req.files || []).map(f => f.path);
    try {
        const { descricao } = req.body;
        const replicateApiKey = req.headers['x-replicate-api-key']; // Esperamos que o frontend envie a chave no header

        if (!descricao) {
            return res.status(400).send('A descrição da música é obrigatória.');
        }
        if (!replicateApiKey) {
            return res.status(400).send('A chave da API da Replicate não foi fornecida.');
        }

        console.log(`Iniciando geração de música para: "${descricao}"`);

        // Etapa 1: Iniciar a predição na Replicate
        const startResponse = await fetch("https://api.replicate.com/v1/predictions", {
            method: "POST",
            headers: {
                "Authorization": `Token ${replicateApiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                version: "8cf61ea6c56afd61d8f5b9ffd14d7c216c0a93844ce2d82ac1c9ecc9c7f24e05", // Versão do modelo MusicGen
                input: {
                    model_version: "stereo-large",
                    prompt: descricao,
                    duration: 10 // Duração em segundos (pode ajustar)
                },
            }),
        });

        const prediction = await startResponse.json();
        if (startResponse.status !== 201) {
            throw new Error(prediction.detail || "Falha ao iniciar a geração na Replicate.");
        }

        let predictionUrl = prediction.urls.get;
        let generatedMusicUrl = null;

        // Etapa 2: Verificar o estado da predição até estar concluída
        while (!generatedMusicUrl) {
            console.log("A verificar o estado da geração...");
            await new Promise(resolve => setTimeout(resolve, 3000)); // Espera 3 segundos

            const statusResponse = await fetch(predictionUrl, {
                headers: { "Authorization": `Token ${replicateApiKey}` },
            });
            const statusResult = await statusResponse.json();

            if (statusResult.status === "succeeded") {
                generatedMusicUrl = statusResult.output;
                break;
            } else if (statusResult.status === "failed") {
                throw new Error("A geração da música falhou na Replicate.");
            }
        }

        console.log("Música gerada com sucesso:", generatedMusicUrl);

        // Etapa 3: Fazer o download da música gerada e enviá-la ao utilizador
        const musicResponse = await fetch(generatedMusicUrl);
        if (!musicResponse.ok) {
            throw new Error("Falha ao fazer o download da música gerada.");
        }

        res.setHeader('Content-Type', 'audio/mpeg');
        musicResponse.body.pipe(res);

    } catch (error) {
        console.error('Erro ao gerar música:', error);
        safeDeleteFiles(allTempFiles);
        if (!res.headersSent) {
            res.status(500).send(`Erro interno ao gerar a música: ${error.message}`);
        }
    }
});

// --- ROTA PARA CLONAGEM DE VOZ (ELEVENLABS) ---
app.post('/clonar-voz', upload.single('audio'), async (req, res) => {
    const audioFile = req.file;
    const { text } = req.body;
    const allTempFiles = [audioFile?.path].filter(Boolean);

    if (!audioFile || !text) {
        safeDeleteFiles(allTempFiles);
        return res.status(400).send('Faltam a amostra de áudio ou o texto.');
    }

    try {
        const elevenlabsApiKey = process.env.ELEVENLABS_API_KEY || req.headers['x-elevenlabs-api-key'];
        if (!elevenlabsApiKey) {
            throw new Error("A chave da API da ElevenLabs não está configurada.");
        }

        console.log("Iniciando processo de clonagem de voz...");

        // Etapa 1: Adicionar a voz à sua conta ElevenLabs
        const formData = new FormData();
        formData.append('name', `VozClonada_${Date.now()}`);
        formData.append('files', fs.createReadStream(audioFile.path), audioFile.originalname);

        const addVoiceResponse = await fetch("https://api.elevenlabs.io/v1/voices/add", {
            method: 'POST',
            headers: { 'xi-api-key': elevenlabsApiKey },
            body: formData,
        });

        if (!addVoiceResponse.ok) throw new Error(`API da ElevenLabs (Add Voice) retornou um erro: ${await addVoiceResponse.text()}`);
        const { voice_id } = await addVoiceResponse.json();
        console.log("Voz temporária criada com ID:", voice_id);

        // Etapa 2: Gerar o áudio com a nova voz
        const ttsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id}/stream`, {
            method: 'POST',
            headers: { 'xi-api-key': elevenlabsApiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: text,
                model_id: "eleven_multilingual_v2",
                voice_settings: { stability: 0.5, similarity_boost: 0.75 }
            }),
        });

        if (!ttsResponse.ok) throw new Error(`API da ElevenLabs (TTS) retornou um erro: ${await ttsResponse.text()}`);

        // Etapa 3: Enviar o áudio de volta e apagar a voz temporária
        res.setHeader('Content-Type', 'audio/mpeg');
        ttsResponse.body.pipe(res);

        // Apaga a voz clonada após o envio para não encher a sua conta
        res.on('finish', async () => {
            console.log("A apagar a voz temporária:", voice_id);
            await fetch(`https://api.elevenlabs.io/v1/voices/${voice_id}`, {
                method: 'DELETE',
                headers: { 'xi-api-key': elevenlabsApiKey }
            });
            safeDeleteFiles(allTempFiles);
        });

    } catch (error) {
        console.error('Erro no processo de clonagem de voz:', error);
        safeDeleteFiles(allTempFiles);
        if (!res.headersSent) res.status(500).send(`Erro interno na clonagem de voz: ${error.message}`);
    }
});

// --- ROTA PARA GERADOR DE EFEITOS SONOROS (REPLICATE) ---
app.post('/gerar-sfx', upload.none(), async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) {
        return res.status(400).send('A descrição do efeito sonoro é obrigatória.');
    }

    try {
        const replicateApiKey = req.headers['x-replicate-api-key'];
        if (!replicateApiKey) {
            throw new Error("A chave da API da Replicate não foi fornecida.");
        }

        console.log(`Iniciando geração de SFX para: "${prompt}"`);

        // Etapa 1: Iniciar a predição na Replicate
        const startResponse = await fetch("https://api.replicate.com/v1/predictions", {
            method: "POST",
            headers: { "Authorization": `Token ${replicateApiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                version: "b05b1dff1d8c6ac63d424224fe93a2e79c5689a8b653e7a41da33e5737e4558e", // Modelo AudioGen
                input: {
                    text: prompt,
                    duration: 5 // Duração em segundos
                },
            }),
        });

        const prediction = await startResponse.json();
        if (startResponse.status !== 201) throw new Error(prediction.detail || "Falha ao iniciar a geração na Replicate.");

        let predictionUrl = prediction.urls.get;
        let generatedSfxUrl = null;

        // Etapa 2: Verificar o estado da predição
        while (!generatedSfxUrl) {
            console.log("A verificar o estado da geração de SFX...");
            await new Promise(resolve => setTimeout(resolve, 3000));
            const statusResponse = await fetch(predictionUrl, { headers: { "Authorization": `Token ${replicateApiKey}` } });
            const statusResult = await statusResponse.json();
            if (statusResult.status === "succeeded") {
                generatedSfxUrl = statusResult.output;
                break;
            } else if (statusResult.status === "failed") {
                throw new Error("A geração do SFX falhou na Replicate.");
            }
        }

        console.log("SFX gerado com sucesso:", generatedSfxUrl);

        // Etapa 3: Fazer o download e enviar ao utilizador
        const sfxResponse = await fetch(generatedSfxUrl);
        if (!sfxResponse.ok) throw new Error("Falha ao fazer o download do SFX gerado.");

        res.setHeader('Content-Type', 'audio/wav');
        sfxResponse.body.pipe(res);

    } catch (error) {
        console.error('Erro ao gerar SFX:', error);
        if (!res.headersSent) res.status(500).send(`Erro interno ao gerar SFX: ${error.message}`);
    }
});

// --- ROTA PARA WORKFLOW MÁGICO (COM NARRAÇÃO GEMINI E EFEITOS) ---
app.post('/workflow-magico-avancado', upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'intro', maxCount: 1 },
    { name: 'outro', maxCount: 1 }
]), async (req, res) => {
    const { topic, settings: settingsStr } = req.body;
    const settings = JSON.parse(settingsStr);
    let allTempFiles = [];

    try {
        const logoFile = req.files.logo?.[0];
        const introFile = req.files.intro?.[0];
        const outroFile = req.files.outro?.[0];
        if(logoFile) allTempFiles.push(logoFile.path);
        if(introFile) allTempFiles.push(introFile.path);
        if(outroFile) allTempFiles.push(outroFile.path);

        // CORREÇÃO: Remove a verificação da chave da OpenAI
        const geminiApiKey = req.headers['x-gemini-api-key'];
        const pexelsApiKey = req.headers['x-pexels-api-key'];
        const stabilityApiKey = req.headers['x-stability-api-key'];

        if (!geminiApiKey || !pexelsApiKey || !stabilityApiKey) {
            throw new Error("As chaves de API do Gemini, Pexels e Stability AI são necessárias.");
        }

        console.log(`[Workflow Avançado] Iniciado para o tópico: "${topic}"`);

        // --- Etapa 1: Gerar Roteiro ---
        console.log("[Workflow] Etapa 1/8: A gerar roteiro...");
        const scriptPrompt = `Crie um roteiro para um vídeo curto (40-60 segundos) sobre "${topic}". O roteiro deve ser envolvente, informativo e dividido em frases curtas. Responda APENAS com o texto do roteiro.`;
        const scriptResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${geminiApiKey}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: scriptPrompt }] }] })
        });
        if (!scriptResponse.ok) throw new Error("Falha ao gerar o roteiro.");
        const scriptData = await scriptResponse.json();
        const script = scriptData.candidates[0].content.parts[0].text.trim();

        // --- Etapa 2: Gerar Narração com Gemini ---
        console.log("[Workflow] Etapa 2/8: A gerar narração...");
        const narrationPrompt = `Diga com uma voz calma e informativa: ${script}`;
        const narrationResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${geminiApiKey}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: "gemini-2.5-flash-preview-tts", contents: [{ parts: [{ text: narrationPrompt }] }],
                generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } } } }
            })
        });
        if (!narrationResponse.ok) throw new Error(`Falha ao gerar a narração: ${await narrationResponse.text()}`);
        const narrationData = await narrationResponse.json();
        const audioPart = narrationData.candidates[0].content.parts[0];
        const audioBase64 = audioPart.inlineData.data;
        const sampleRate = parseInt(audioPart.inlineData.mimeType.match(/rate=(\d+)/)[1], 10);
        const pcmData = Buffer.from(audioBase64, 'base64');
        const wavBuffer = pcmToWavBuffer(pcmData, sampleRate);
        const narrationPath = path.join(uploadDir, `narration-${Date.now()}.wav`);
        fs.writeFileSync(narrationPath, wavBuffer);
        allTempFiles.push(narrationPath);

        // O resto das etapas (3 em diante) continua igual...
        // ...

        // --- Etapa Final: Enviar Resposta Completa ---
        const videoDataUrl = `data:video/mp4;base64,${fs.readFileSync(finalVideoPath).toString('base64')}`;
        
        res.json({
            videoDataUrl: videoDataUrl,
            thumbnails: [], // Placeholder
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

        // --- Etapa 3: Analisar Cenas ---
        console.log("[Workflow] Etapa 3/8: A analisar cenas...");
        const scenesPrompt = `Analise este roteiro e divida-o em 5 a 8 cenas visuais. Para cada cena, forneça um termo de busca conciso e em inglês para encontrar um vídeo de stock. Retorne um array de objetos JSON. Exemplo: [{"cena": 1, "termo_busca": "person meditating peacefully"}, ...]. Roteiro: "${script}"`;
        const scenesResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${geminiApiKey}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: scenesPrompt }] }], generationConfig: { responseMimeType: "application/json" } })
        });
        if (!scenesResponse.ok) throw new Error("Falha ao analisar as cenas.");
        const scenesData = await scenesResponse.json();
        const scenes = JSON.parse(scenesData.candidates[0].content.parts[0].text);

        // --- Etapa 4: Busca de Mídia Híbrida ---
        console.log("[Workflow] Etapa 4/8: A buscar mídias (híbrido)...");
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
                console.log(`Nenhum vídeo encontrado para "${scene.termo_busca}". A gerar imagem com IA...`);
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

        // --- Etapa 5: Montagem com Efeitos ---
        console.log("[Workflow] Etapa 5/8: A montar o vídeo com efeitos...");
        const [width, height] = settings.format === '9:16' ? [1080, 1920] : [1920, 1080];
        
        let filterComplex = '';
        mediaPaths.forEach((p, i) => {
            filterComplex += `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}];`;
        });
        
        for (let i = 0; i < mediaPaths.length - 1; i++) {
            const input1 = i === 0 ? `[v${i}]` : `[vt${i-1}]`;
            const input2 = `[v${i+1}]`;
            const output = `[vt${i}]`;
            filterComplex += `${input1}${input2}xfade=transition=${settings.transition}:duration=1:offset=${(i+1)*4}${output};`;
        }

        let lastVideoOutput = `[vt${mediaPaths.length - 2}]`;
        
        if (settings.filter !== 'none') {
            let filterName = '';
            if (settings.filter === 'cinematic') filterName = ',eq=contrast=1.1:saturation=1.2';
            if (settings.filter === 'vintage') filterName = ',sepia';
            filterComplex += `${lastVideoOutput}${filterName}[v_filtered];`;
            lastVideoOutput = '[v_filtered]';
        }

        const silentVideoPath = path.join(processedDir, `silent_complex-${Date.now()}.mp4`);
        allTempFiles.push(silentVideoPath);
        
        const ffmpegInputs = mediaPaths.map(p => `-i "${p}"`).join(' ');
        await runFFmpeg(`ffmpeg ${ffmpegInputs} -filter_complex "${filterComplex}" -map "${lastVideoOutput}" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -y "${silentVideoPath}"`);

        // --- Etapa 6: Adicionar Áudio ---
        console.log("[Workflow] Etapa 6/8: A adicionar áudio...");
        const audioVideoPath = path.join(processedDir, `audio-video-${Date.now()}.mp4`);
        allTempFiles.push(audioVideoPath);
        await runFFmpeg(`ffmpeg -i "${silentVideoPath}" -i "${narrationPath}" -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest -y "${audioVideoPath}"`);

        // --- Etapa 7: Adicionar Intro/Outro ---
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
        } else {
            console.log("[Workflow] Etapa 7/8: A saltar Intro/Outro...");
        }

        // --- Etapa 8: Gerar Conteúdo Extra ---
        console.log("[Workflow] Etapa 8/8: A gerar conteúdo extra...");
        const youtubePrompt = `Aja como um especialista em SEO para YouTube. Para um vídeo sobre "${topic}", gere 3 títulos chamativos e uma descrição otimizada com hashtags. Retorne como um objeto JSON com as chaves "titles" (um array de strings) e "description" (uma string).`;
        const youtubeResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${geminiApiKey}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: youtubePrompt }] }], generationConfig: { responseMimeType: "application/json" } })
        });
        const youtubeData = await youtubeResponse.json();
        const youtubeContent = JSON.parse(youtubeData.candidates[0].content.parts[0].text);

        // --- Etapa Final: Enviar Resposta Completa ---
        const videoDataUrl = `data:video/mp4;base64,${fs.readFileSync(finalVideoPath).toString('base64')}`;
        
        res.json({
            videoDataUrl: videoDataUrl,
            thumbnails: [], // A geração de thumbnail é muito complexa, deixamos como placeholder
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
// --- ROTA PARA GERADOR DE LOGOTIPOS (IA) - COM MODELO CORRIGIDO ---
app.post('/gerar-logo', upload.none(), async (req, res) => {
    const { prompt } = req.body;

    if (!prompt) {
        return res.status(400).send('A descrição do logotipo é obrigatória.');
    }

    try {
        const stabilityApiKey = process.env.STABILITY_API_KEY || req.headers['x-stability-api-key'];
        if (!stabilityApiKey) {
            throw new Error("A chave da API da Stability AI não está configurada.");
        }

        console.log("Iniciando geração de logotipos com o prompt:", prompt);

        const payload = {
            text_prompts: [
                {
                    text: `${prompt}, professional logo, vector, minimalist, flat design`
                }
            ],
            cfg_scale: 7,
            samples: 4,
            steps: 30,
            width: 1024,
            height: 1024,
        };

        // --- ALTERAÇÃO PRINCIPAL AQUI ---
        // Trocamos 'stable-diffusion-v1-6' pelo modelo mais recente 'stable-diffusion-xl-1024-v1-0'
        const response = await fetch(
            "https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image",
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${stabilityApiKey}`
                },
                body: JSON.stringify(payload),
            }
        );

        if (!response.ok) {
            throw new Error(`API da Stability AI retornou um erro: ${await response.text()}`);
        }

        const responseJSON = await response.json();
        
        const images = responseJSON.artifacts.map(image => ({
            base64: image.base64
        }));

        console.log(`${images.length} logotipos gerados com sucesso.`);
        res.json({ images });

    } catch (error) {
        console.error('Erro no processo de geração de logotipos:', error);
        if (!res.headersSent) {
            res.status(500).send(`Erro interno na geração de logotipos: ${error.message}`);
        }
    }
});

// --- ROTAS DO IA TURBO ---

app.post('/extrair-audio', upload.any(), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).send('Nenhum ficheiro enviado.');

    // Rota IA Turbo (single file, fieldname 'video')
    if (files.length === 1 && files[0].fieldname === 'video') {
        const file = files[0];
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
    } 
    // Rota Ferramenta Genérica (multiple files, fieldname 'videos')
    else {
        const allTempFiles = files.map(f => f.path);
        try {
            const processedFiles = [];
            for (const file of files) {
                const outputFilename = `${path.parse(file.filename).name}.mp3`;
                const outputPath = path.join(processedDir, `extraido-${outputFilename}`);
                allTempFiles.push(outputPath);
                await runFFmpeg(`ffmpeg -i "${file.path}" -vn -q:a 0 -map a -y "${outputPath}"`);
                processedFiles.push({ path: outputPath, name: path.basename(outputPath) });
            }
            sendZipResponse(res, processedFiles, allTempFiles);
        } catch (e) {
            safeDeleteFiles(allTempFiles);
            res.status(500).send(e.message);
        }
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
        
        const sceneDetectionThreshold = 0.4;
        await runFFmpeg(`ffmpeg -i "${file.path}" -vf "select='gt(scene,${sceneDetectionThreshold})'" -vsync vfr -y "${outputPattern}"`);
        
        let frameFiles = fs.readdirSync(processedDir).filter(f => f.startsWith(uniquePrefix));
        allTempFiles.push(...frameFiles.map(f => path.join(processedDir, f)));

        if (frameFiles.length === 0) {
            console.log("Nenhuma mudança de cena detectada. Extraindo frames a cada 5 segundos.");
            await runFFmpeg(`ffmpeg -i "${file.path}" -vf fps=1/5 -y "${outputPattern}"`);
            frameFiles = fs.readdirSync(processedDir).filter(f => f.startsWith(uniquePrefix));
            allTempFiles.push(...frameFiles.map(f => path.join(processedDir, f)));
        }

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

app.post('/mixar-video-turbo-advanced', upload.single('narration'), async (req, res) => {
    const narrationFile = req.file;
    const { images, script, imageDuration, videoType, blockSize, transition } = req.body;

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
            
            const effectFilter = getEffectFilter(transition, durationPerImage, dValue, videoWidth, videoHeight);

            await runFFmpeg(
                `ffmpeg -f concat -safe 0 -i "${fileListPath}" ` +
                `-vf "scale=${videoWidth}:${videoHeight}:force_original_aspect_ratio=decrease,pad=${videoWidth}:${videoHeight}:-1:-1,${effectFilter},format=yuv420p" ` +
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

// 6. Iniciar Servidor
app.listen(PORT, () => {
    console.log(`Servidor a correr na porta ${PORT}`);
});

















































