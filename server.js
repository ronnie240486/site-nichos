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

// --- ROTA PARA INPAINTING (COM MODELO ESPECIALIZADO E PROMPT DINÂMICO) ---
app.post('/inpainting', upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'mask', maxCount: 1 }
]), async (req, res) => {
    const imageFile = req.files.image?.[0];
    const maskFile = req.files.mask?.[0];
    // Pega o prompt enviado pelo frontend
    const { prompt } = req.body;
    let allTempFiles = [imageFile?.path, maskFile?.path].filter(Boolean);

    if (!imageFile || !maskFile || !prompt) {
        safeDeleteFiles(allTempFiles);
        return res.status(400).send('Faltam a imagem, a máscara ou o prompt.');
    }

    try {
        const stabilityApiKey = process.env.STABILITY_API_KEY || req.headers['x-stability-api-key'];
        if (!stabilityApiKey) throw new Error("A chave da API da Stability AI não está configurada.");

        console.log("Iniciando processo de Inpainting com modelo especializado...");

        // Lógica de redimensionamento (mantida para evitar erros de dimensão)
        const ffprobeCommand = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${imageFile.path}"`;
        const dimensions = await new Promise((resolve, reject) => {
            exec(ffprobeCommand, (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
        });
        const [originalWidth, originalHeight] = dimensions.split('x').map(Number);
        const allowedDimensions = [
            { w: 1024, h: 1024 }, { w: 1152, h: 896 }, { w: 1216, h: 832 },
            { w: 1344, h: 768 }, { w: 1536, h: 640 }, { w: 640, h: 1536 },
            { w: 768, h: 1344 }, { w: 832, h: 1216 }, { w: 896, h: 1152 }
        ];
        const originalAspectRatio = originalWidth / originalHeight;
        let bestDimension = allowedDimensions[0];
        let minAspectRatioDiff = Infinity;
        allowedDimensions.forEach(dim => {
            const diff = Math.abs((dim.w / dim.h) - originalAspectRatio);
            if (diff < minAspectRatioDiff) {
                minAspectRatioDiff = diff;
                bestDimension = dim;
            }
        });
        const resizedImagePath = path.join(uploadDir, `resized-${imageFile.filename}`);
        const resizedMaskPath = path.join(uploadDir, `resized-mask-${maskFile.filename}`);
        allTempFiles.push(resizedImagePath, resizedMaskPath);
        const resizeCommandImage = `ffmpeg -i "${imageFile.path}" -vf "scale=${bestDimension.w}:${bestDimension.h}:force_original_aspect_ratio=decrease,pad=${bestDimension.w}:${bestDimension.h}:-1:-1:color=black" -y "${resizedImagePath}"`;
        const resizeCommandMask = `ffmpeg -i "${maskFile.path}" -vf "scale=${bestDimension.w}:${bestDimension.h}:force_original_aspect_ratio=decrease,pad=${bestDimension.w}:${bestDimension.h}:-1:-1:color=black" -y "${resizedMaskPath}"`;
        await runFFmpeg(resizeCommandImage);

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









