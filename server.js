// server.js - Backend para a aplicação DarkMaker (Versão Estável e Otimizada)

const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

// Pastas
const uploadDir = path.join(__dirname, 'uploads');
const processedDir = path.join(__dirname, 'processed');

// Garante que as pastas existem
[uploadDir, processedDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Middlewares
app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(processedDir)); // rota pública para downloads

// Configuração do Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safeOriginalName}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 } // limite 500MB
});

// Funções auxiliares
function runFFmpeg(command, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`Executando FFmpeg: ${command}`);
    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        console.error(`FFmpeg Erro: ${stderr}`);
        return reject(new Error(`Erro no FFmpeg: ${stderr || 'Desconhecido'}`));
      }
      console.log(`FFmpeg OK: ${stdout}`);
      resolve(true);
    });
  });
}

function getMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`ffprobe Erro: ${stderr}`);
        return reject(new Error(`Erro no ffprobe: ${stderr}`));
      }
      resolve(parseFloat(stdout));
    });
  });
}

// Limpeza automática de arquivos com mais de 24h
setInterval(() => {
  const limite = Date.now() - 24 * 60 * 60 * 1000;
  [uploadDir, processedDir].forEach(dir => {
    fs.readdirSync(dir).forEach(file => {
      const filePath = path.join(dir, file);
      if (fs.statSync(filePath).mtime.getTime() < limite) {
        fs.unlinkSync(filePath);
        console.log(`🗑 Arquivo apagado: ${filePath}`);
      }
    });
  });
}, 3600000); // a cada 1 hora

// Rotas
app.get('/', (req, res) => res.send('✅ Backend DarkMaker está rodando!'));

// -------------------- Cortar vídeo --------------------
app.post('/cortar-video', upload.single('videos'), async (req, res) => {
  if (!req.file) return res.status(400).send('Nenhum arquivo enviado.');
  const { startTime, endTime } = req.body;
  if (!startTime || !endTime) return res.status(400).send('Tempos de início e fim obrigatórios.');

  const inputPath = req.file.path;
  const outputPath = path.join(processedDir, `cortado-${req.file.filename}`);

  try {
    await runFFmpeg(`ffmpeg -i "${inputPath}" -ss ${startTime} -to ${endTime} -c copy "${outputPath}"`);
    res.json({ url: `/downloads/${path.basename(outputPath)}` });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// -------------------- Unir vídeos --------------------
app.post('/unir-videos', upload.array('videos'), async (req, res) => {
  if (req.files.length < 2) return res.status(400).send('Envie pelo menos dois vídeos.');
  const listFile = path.join(uploadDir, `list-${Date.now()}.txt`);
  fs.writeFileSync(listFile, req.files.map(f => `file '${f.filename}'`).join('\n'));
  const outputPath = path.join(processedDir, `unido-${Date.now()}.mp4`);

  try {
    await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${path.basename(listFile)}" -vcodec libx264 -crf 23 -preset veryfast "${outputPath}"`, { cwd: uploadDir });
    res.json({ url: `/downloads/${path.basename(outputPath)}` });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// -------------------- Comprimir vídeo --------------------
app.post('/comprimir-videos', upload.single('videos'), async (req, res) => {
  if (!req.file) return res.status(400).send('Nenhum arquivo enviado.');
  const { quality } = req.body;
  const crfMap = { alta: '18', media: '23', baixa: '28' };
  const crf = crfMap[quality] || '23';

  const inputPath = req.file.path;
  const outputPath = path.join(processedDir, `comprimido-${req.file.filename}`);

  try {
    await runFFmpeg(`ffmpeg -i "${inputPath}" -vcodec libx264 -crf ${crf} "${outputPath}"`);
    res.json({ url: `/downloads/${path.basename(outputPath)}` });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// -------------------- Embaralhar vídeos --------------------
app.post('/embaralhar-videos', upload.array('videos'), async (req, res) => {
  if (req.files.length < 2) return res.status(400).send('Envie pelo menos dois vídeos.');
  const shuffled = [...req.files].sort(() => Math.random() - 0.5);
  const listFile = path.join(uploadDir, `list-emb-${Date.now()}.txt`);
  fs.writeFileSync(listFile, shuffled.map(f => `file '${f.filename}'`).join('\n'));
  const outputPath = path.join(processedDir, `embaralhado-${Date.now()}.mp4`);

  try {
    await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${path.basename(listFile)}" -vcodec libx264 -crf 23 -preset veryfast "${outputPath}"`, { cwd: uploadDir });
    res.json({ url: `/downloads/${path.basename(outputPath)}` });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// -------------------- Remover áudio/metadados --------------------
app.post('/remover-audio', upload.single('videos'), async (req, res) => {
  if (!req.file) return res.status(400).send('Nenhum arquivo enviado.');
  const { removeAudio, removeMetadata } = req.body;
  let flags = '-c:v copy';
  if (removeAudio === 'true') flags += ' -an';
  else flags += ' -c:a copy';
  if (removeMetadata === 'true') flags += ' -map_metadata -1';

  if (removeAudio !== 'true' && removeMetadata !== 'true')
    return res.status(400).send('Nenhuma opção selecionada.');

  const inputPath = req.file.path;
  const outputPath = path.join(processedDir, `processado-${req.file.filename}`);

  try {
    await runFFmpeg(`ffmpeg -i "${inputPath}" ${flags} "${outputPath}"`);
    res.json({ url: `/downloads/${path.basename(outputPath)}` });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// -------------------- Criar vídeo automático --------------------
app.post('/criar-video-automatico', upload.fields([
  { name: 'narration', maxCount: 1 },
  { name: 'media', maxCount: 50 }
]), async (req, res) => {
  const narrationFile = req.files.narration?.[0];
  const mediaFiles = req.files.media || [];
  if (!narrationFile || mediaFiles.length === 0)
    return res.status(400).send('Narração e pelo menos uma imagem são obrigatórias.');

  const fileList = path.join(uploadDir, `list-auto-${Date.now()}.txt`);
  const silentVideo = path.join(processedDir, `silent-${Date.now()}.mp4`);
  const outputPath = path.join(processedDir, `automatico-${Date.now()}.mp4`);

  try {
    const audioDuration = await getMediaDuration(narrationFile.path);
    const dur = audioDuration / mediaFiles.length;
    fs.writeFileSync(fileList, mediaFiles.map(f => `file '${f.filename}'\nduration ${dur}`).join('\n'));

    await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${path.basename(fileList)}" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -vcodec libx264 -r 25 -y "${silentVideo}"`, { cwd: uploadDir });

    await runFFmpeg(`ffmpeg -i "${silentVideo}" -i "${narrationFile.path}" -c:v copy -c:a aac -shortest "${outputPath}"`);

    res.json({ url: `/downloads/${path.basename(outputPath)}` });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// Inicia servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
