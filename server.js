// server.js - Backend para a aplicação DarkMaker

// 1. Importação de Módulos
const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { YoutubeTranscript } = require('youtube-transcript');

// 2. Configuração Inicial
const app = express();
const PORT = process.env.PORT || 10000;

// Cria as pastas necessárias de forma síncrona ao iniciar
const uploadDir = path.join(__dirname, 'uploads');
const processedDir = path.join(__dirname, 'processed');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir);

// 3. Middlewares
app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(processedDir));

// Configuração do Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safeOriginalName}`);
  }
});
const upload = multer({ storage: storage });

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

// 5. Rotas
app.get('/', (req, res) => res.send('Backend DarkMaker está a funcionar!'));

// --- ROTA PARA EXTRAIR ROTEIRO DO YOUTUBE ---
app.post('/extrair-roteiro', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL do YouTube não fornecida.' });
  }

  try {
    const transcript = await YoutubeTranscript.fetchTranscript(url);
    if (!transcript || transcript.length === 0) {
      return res.status(404).json({ error: 'Nenhuma transcrição encontrada para este vídeo.' });
    }
    const roteiroCompleto = transcript.map(item => item.text).join(' ');
    res.json({ roteiro: roteiroCompleto });
  } catch (error) {
    console.error("Erro ao buscar transcrição:", error.message);
    res.status(500).json({ error: 'Falha ao processar o vídeo. Verifique se a URL está correta e se o vídeo possui legendas.' });
  }
});

// --- ROTAS DE PROCESSAMENTO DE VÍDEO ---

app.post('/cortar-video', upload.single('media'), async (req, res) => {
  const inputPath = req.file?.path;
  if (!inputPath) return res.status(400).send('Nenhum ficheiro enviado.');
  const { startTime, endTime } = req.body;
  if (!startTime || !endTime) return res.status(400).send('Tempos obrigatórios.');
  const outputPath = path.join(processedDir, `cortado-${req.file.filename}`);
  try {
    await runFFmpeg(`ffmpeg -i "${inputPath}" -ss ${startTime} -to ${endTime} -c copy "${outputPath}"`);
    res.download(outputPath, () => {
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    });
  } catch (e) {
    fs.unlinkSync(inputPath);
    res.status(500).send(e.message);
  }
});

app.post('/unir-videos', upload.array('media'), async (req, res) => {
  const files = req.files || [];
  if (files.length < 2) return res.status(400).send('Mínimo 2 vídeos.');
  const fileListPath = path.join(uploadDir, `list-${Date.now()}.txt`);
  const outputPath = path.join(processedDir, `unido-${Date.now()}.mp4`);
  const fileContent = files.map(f => `file '${f.path.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(fileListPath, fileContent);
  try {
    await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy "${outputPath}"`);
    res.download(outputPath, () => {
      files.forEach(f => fs.unlinkSync(f.path));
      fs.unlinkSync(fileListPath);
      fs.unlinkSync(outputPath);
    });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.post('/comprimir-videos', upload.single('media'), async (req, res) => {
  const inputPath = req.file?.path;
  if (!inputPath) return res.status(400).send('Nenhum ficheiro enviado.');
  const crfMap = { alta: '18', media: '23', baixa: '28' };
  const crf = crfMap[req.body.quality] || '23';
  const outputPath = path.join(processedDir, `comprimido-${req.file.filename}`);
  try {
    await runFFmpeg(`ffmpeg -i "${inputPath}" -vcodec libx264 -crf ${crf} "${outputPath}"`);
    res.download(outputPath, () => {
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.post('/embaralhar-videos', upload.array('media'), async (req, res) => {
    const files = req.files || [];
    if (files.length < 2) return res.status(400).send('Mínimo 2 vídeos.');
    const shuffled = files.sort(() => Math.random() - 0.5);
    const fileListPath = path.join(uploadDir, `list-shuf-${Date.now()}.txt`);
    const outputPath = path.join(processedDir, `embaralhado-${Date.now()}.mp4`);
    const fileContent = shuffled.map(f => `file '${f.path.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(fileListPath, fileContent);
    try {
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy "${outputPath}"`);
        res.download(outputPath, () => {
            files.forEach(f => fs.unlinkSync(f.path));
            fs.unlinkSync(fileListPath);
            fs.unlinkSync(outputPath);
        });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/remover-audio', upload.single('media'), async (req, res) => {
    const inputPath = req.file?.path;
    if (!inputPath) return res.status(400).send('Nenhum ficheiro enviado.');
    const outputPath = path.join(processedDir, `processado-${req.file.filename}`);
    let flags = '-c:v copy';
    if (req.body.removeAudio === 'true') flags += ' -an';
    else flags += ' -c:a copy';
    if (req.body.removeMetadata === 'true') flags += ' -map_metadata -1';
    if (req.body.removeAudio !== 'true' && req.body.removeMetadata !== 'true') {
        return res.status(400).send('Nenhuma opção selecionada.');
    }
    try {
        await runFFmpeg(`ffmpeg -i "${inputPath}" ${flags} "${outputPath}"`);
        res.download(outputPath, () => {
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
        });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// --- ROTAS DE PROCESSAMENTO DE ÁUDIO ---

app.post('/unir-audio', upload.array('media'), async (req, res) => {
    const files = req.files || [];
    if (files.length < 2) return res.status(400).send('Mínimo 2 ficheiros de áudio.');
    const fileListPath = path.join(uploadDir, `list-audio-${Date.now()}.txt`);
    const outputPath = path.join(processedDir, `unido-${Date.now()}.mp3`);
    const fileContent = files.map(f => `file '${f.path.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(fileListPath, fileContent);
    try {
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c:a libmp3lame -q:a 2 "${outputPath}"`);
        res.download(outputPath, () => {
            files.forEach(f => fs.unlinkSync(f.path));
            fs.unlinkSync(fileListPath);
            fs.unlinkSync(outputPath);
        });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/limpar-metadados-audio', upload.single('media'), async (req, res) => {
    const inputPath = req.file?.path;
    if (!inputPath) return res.status(400).send('Nenhum ficheiro enviado.');
    const outputPath = path.join(processedDir, `limpo-${path.basename(inputPath)}`);
    try {
        await runFFmpeg(`ffmpeg -i "${inputPath}" -map_metadata -1 -c:a copy "${outputPath}"`);
        res.download(outputPath, () => {
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
        });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/extrair-audio', upload.single('media'), async (req, res) => {
    const inputPath = req.file?.path;
    if (!inputPath) return res.status(400).send('Nenhum ficheiro enviado.');
    const outputFilename = `${path.parse(req.file.filename).name}.mp3`;
    const outputPath = path.join(processedDir, outputFilename);
    try {
        await runFFmpeg(`ffmpeg -i "${inputPath}" -vn -c:a libmp3lame -q:a 2 "${outputPath}"`);
        res.download(outputPath, () => {
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
        });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/embaralhar-audio', upload.array('media'), async (req, res) => {
    const files = req.files || [];
    if (files.length < 2) return res.status(400).send('Mínimo 2 ficheiros de áudio.');
    const shuffled = files.sort(() => Math.random() - 0.5);
    const fileListPath = path.join(uploadDir, `list-audio-shuf-${Date.now()}.txt`);
    const outputPath = path.join(processedDir, `embaralhado-${Date.now()}.mp3`);
    const fileContent = shuffled.map(f => `file '${f.path.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(fileListPath, fileContent);
    try {
        await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c:a libmp3lame -q:a 2 "${outputPath}"`);
        res.download(outputPath, () => {
            files.forEach(f => fs.unlinkSync(f.path));
            fs.unlinkSync(fileListPath);
            fs.unlinkSync(outputPath);
        });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/melhorar-audio', upload.single('media'), async (req, res) => {
    const inputPath = req.file?.path;
    if (!inputPath) return res.status(400).send('Nenhum ficheiro enviado.');
    const { removeNoise, normalizeVolume } = req.body;
    let filters = [];
    if (removeNoise === 'true') filters.push('anlmdn');
    if (normalizeVolume === 'true') filters.push('loudnorm');
    const filterString = filters.length > 0 ? `-af "${filters.join(',')}"` : '';
    const outputPath = path.join(processedDir, `melhorado-${path.basename(inputPath)}`);
    try {
        await runFFmpeg(`ffmpeg -i "${inputPath}" ${filterString} "${outputPath}"`);
        res.download(outputPath, () => {
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
        });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/remover-silencio', upload.single('media'), async (req, res) => {
    const inputPath = req.file?.path;
    if (!inputPath) return res.status(400).send('Nenhum ficheiro enviado.');
    const threshold = req.body.silenceThreshold || '-30dB';
    const duration = req.body.silenceDuration || '1';
    const outputPath = path.join(processedDir, `sem-silencio-${path.basename(inputPath)}`);
    try {
        await runFFmpeg(`ffmpeg -i "${inputPath}" -af silenceremove=stop_periods=-1:stop_duration=${duration}:stop_threshold=${threshold} "${outputPath}"`);
        res.download(outputPath, () => {
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
        });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// --- ROTA DE CRIAÇÃO DE VÍDEO AUTOMÁTICO ---

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
  const outputPath = path.join(processedDir, `automatico-${Date.now()}.mp4`);

  try {
    const audioDuration = await getMediaDuration(narrationFile.path);
    const durationPerImage = audioDuration / mediaFiles.length;

    const fileContent = mediaFiles
      .map(f => `file '${f.path.replace(/'/g, "'\\''")}'\nduration ${durationPerImage}`)
      .join('\n');

    const lastFile = mediaFiles[mediaFiles.length - 1].path.replace(/'/g, "'\\''");
    const finalContent = `${fileContent}\nfile '${lastFile}'`;

    fs.writeFileSync(fileListPath, finalContent);

    await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" -c:v libx264 -r 25 -y "${silentVideoPath}"`);
    await runFFmpeg(`ffmpeg -i "${silentVideoPath}" -i "${narrationFile.path}" -c:v copy -c:a aac -shortest -y "${outputPath}"`);

    res.download(outputPath, path.basename(outputPath), () => {
      fs.unlinkSync(narrationFile.path);
      mediaFiles.forEach(f => fs.unlinkSync(f.path));
      fs.unlinkSync(fileListPath);
      fs.unlinkSync(silentVideoPath);
      fs.unlinkSync(outputPath);
    });
  } catch (e) {
    res.status(500).send(e.message);
  }
});


// 6. Iniciar Servidor
app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
