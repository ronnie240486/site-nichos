// server.js - Backend para a aplicação DarkMaker

// 1. Importação de Módulos
const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

// 2. Configuração Inicial
const app = express();
const PORT = process.env.PORT || 10000;

// Cria as pastas necessárias de forma síncrona ao iniciar
const uploadDir = path.join(__dirname, 'uploads');
const processedDir = path.join(__dirname, 'processed');
if (!fs.existsSync(uploadDir)) { fs.mkdirSync(uploadDir); }
if (!fs.existsSync(processedDir)) { fs.mkdirSync(processedDir); }

// 3. Middlewares
app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(processedDir)); // Permite o download dos ficheiros processados

// Configuração do Multer para guardar os ficheiros com nomes únicos e seguros
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
        return reject(new Error(`Erro no FFmpeg: ${stderr || 'Ocorreu um erro desconhecido.'}`));
      }
      console.log(`FFmpeg Stdout: ${stdout}`);
      resolve('Processamento FFmpeg concluído com sucesso.');
    });
  });
}

function getMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`FFprobe Stderr for ${filePath}: ${stderr}`);
        return reject(new Error(`Erro no ffprobe: ${stderr}`));
      }
      resolve(parseFloat(stdout));
    });
  });
}

// 5. Rotas da API
app.get('/', (req, res) => res.send('Backend DarkMaker está a funcionar!'));

// Rota para Cortar Vídeo
app.post('/cortar-video', upload.single('videos'), async (req, res) => {
  const inputPath = req.file ? req.file.path : null;
  if (!inputPath) return res.status(400).send('Nenhum ficheiro de vídeo enviado.');
  
  const { startTime, endTime } = req.body;
  if (!startTime || !endTime) {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    return res.status(400).send('Tempos de início e fim são obrigatórios.');
  }

  const outputFilename = `cortado-${req.file.filename}`;
  const outputPath = path.join(processedDir, outputFilename);
  const command = `ffmpeg -i "${inputPath}" -ss ${startTime} -to ${endTime} -c copy "${outputPath}"`;

  try {
    await runFFmpeg(command);
    res.download(outputPath, outputFilename);
  } catch (error) {
    res.status(500).send(error.message);
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
});

// Rota para Unir Vídeos
app.post('/unir-videos', upload.array('videos'), async (req, res) => {
  const files = req.files || [];
  const filePaths = files.map(f => f.path);
  const fileListPath = path.join(uploadDir, `list-${Date.now()}.txt`);

  const cleanup = () => {
    filePaths.forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });
    if (fs.existsSync(fileListPath)) fs.unlinkSync(fileListPath);
  };

  if (files.length < 2) {
    cleanup();
    return res.status(400).send('Pelo menos dois vídeos são necessários para unir.');
  }

  const fileContent = files.map(f => `file '${f.filename}'`).join('\n');
  fs.writeFileSync(fileListPath, fileContent);

  const outputFilename = `unido-${Date.now()}.mp4`;
  const outputPath = path.join(processedDir, outputFilename);
  const command = `ffmpeg -f concat -safe 0 -i "${path.basename(fileListPath)}" -c copy "${outputPath}"`;

  try {
    await runFFmpeg(command, { cwd: uploadDir });
    res.download(outputPath, outputFilename);
  } catch (error) {
    res.status(500).send(error.message);
  } finally {
    cleanup();
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
});

// Rota para Comprimir Vídeo
app.post('/comprimir-videos', upload.single('videos'), async (req, res) => {
    const inputPath = req.file ? req.file.path : null;
    if (!inputPath) return res.status(400).send('Nenhum ficheiro enviado.');

    const { quality } = req.body;
    const crfMap = { alta: '18', media: '23', baixa: '28' };
    const crf = crfMap[quality] || '23';

    const outputFilename = `comprimido-${req.file.filename}`;
    const outputPath = path.join(processedDir, outputFilename);
    const command = `ffmpeg -i "${inputPath}" -vcodec libx264 -crf ${crf} "${outputPath}"`;

    try {
        await runFFmpeg(command);
        res.download(outputPath, outputFilename);
    } catch (error) {
        res.status(500).send(error.message);
    } finally {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
});

// Rota para Embaralhar Vídeos
app.post('/embaralhar-videos', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    const filePaths = files.map(f => f.path);
    const fileListPath = path.join(uploadDir, `list-embaralhada-${Date.now()}.txt`);

    const cleanup = () => {
      filePaths.forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });
      if (fs.existsSync(fileListPath)) fs.unlinkSync(fileListPath);
    };

    if (files.length < 2) {
      cleanup();
      return res.status(400).send('Pelo menos dois vídeos são necessários para embaralhar.');
    }

    let shuffledFiles = files.sort(() => Math.random() - 0.5);
    const fileContent = shuffledFiles.map(f => `file '${f.filename}'`).join('\n');
    fs.writeFileSync(fileListPath, fileContent);

    const outputFilename = `embaralhado-${Date.now()}.mp4`;
    const outputPath = path.join(processedDir, outputFilename);
    const command = `ffmpeg -f concat -safe 0 -i "${path.basename(fileListPath)}" -c copy "${outputPath}"`;

    try {
        await runFFmpeg(command, { cwd: uploadDir });
        res.download(outputPath, outputFilename);
    } catch (error) {
        res.status(500).send(error.message);
    } finally {
        cleanup();
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
});

// Rota para Remover Áudio e/ou Metadados
app.post('/remover-audio', upload.single('videos'), async (req, res) => {
    const inputPath = req.file ? req.file.path : null;
    if (!inputPath) return res.status(400).send('Nenhum ficheiro enviado.');
    
    const { removeAudio, removeMetadata } = req.body;
    const outputFilename = `processado-${req.file.filename}`;
    const outputPath = path.join(processedDir, outputFilename);

    let flags = '-c:v copy'; 
    if (removeAudio === 'true') {
        flags += ' -an';
    } else {
        flags += ' -c:a copy';
    }
    if (removeMetadata === 'true') {
        flags += ' -map_metadata -1';
    }

    if (removeAudio !== 'true' && removeMetadata !== 'true') {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        return res.status(400).send('Nenhuma opção de remoção selecionada.');
    }

    const command = `ffmpeg -i "${inputPath}" ${flags} "${outputPath}"`;

    try {
        await runFFmpeg(command);
        res.download(outputPath, outputFilename);
    } catch (error) {
        res.status(500).send(error.message);
    } finally {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
});

// Rota para Criar Vídeo Automático
app.post('/criar-video-automatico', upload.fields([
  { name: 'narration', maxCount: 1 },
  { name: 'media', maxCount: 50 }
]), async (req, res) => {
  const narrationFile = req.files.narration ? req.files.narration[0] : null;
  const mediaFiles = req.files.media || [];
  
  const tempFiles = [];
  if (narrationFile) tempFiles.push(narrationFile.path);
  mediaFiles.forEach(f => tempFiles.push(f.path));

  const cleanup = () => {
      tempFiles.forEach(filePath => {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      });
  };

  if (!narrationFile || mediaFiles.length === 0) {
    cleanup();
    return res.status(400).send('Narração e pelo menos um ficheiro de media são obrigatórios.');
  }

  const fileListPath = path.join(uploadDir, `list-auto-${Date.now()}.txt`);
  tempFiles.push(fileListPath);
  const silentVideoPath = path.join(processedDir, `silent-${Date.now()}.mp4`);
  tempFiles.push(silentVideoPath);
  const outputFilename = `automatico-${Date.now()}.mp4`;
  const outputPath = path.join(processedDir, outputFilename);
  tempFiles.push(outputPath);

  try {
    const audioDuration = await getMediaDuration(narrationFile.path);
    const durationPerImage = audioDuration / mediaFiles.length;

    const fileContent = mediaFiles.map(f => `file '${f.filename}'\nduration ${durationPerImage}`).join('\n');
    fs.writeFileSync(fileListPath, fileContent);
    
    const createSilentVideoCmd = `ffmpeg -f concat -safe 0 -i "${path.basename(fileListPath)}" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -c:v libx264 -r 25 -y "${silentVideoPath}"`;
    await runFFmpeg(createSilentVideoCmd, { cwd: uploadDir });

    const addAudioCmd = `ffmpeg -i "${silentVideoPath}" -i "${narrationFile.path}" -c:v copy -c:a aac -shortest "${outputPath}"`;
    await runFFmpeg(addAudioCmd);
    
    res.download(outputPath, outputFilename);
  } catch (error) {
    res.status(500).send(error.message);
  } finally {
    cleanup();
  }
});

// 6. Iniciar o Servidor
app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
