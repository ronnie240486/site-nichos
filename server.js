// 1. Importação de Módulos
const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const archiver = require('archiver'); // <-- ADICIONADO: Para criar ficheiros .zip

// 2. Configuração Inicial
const app = express();
const PORT = process.env.PORT || 10000;

const uploadDir = path.join(__dirname, 'uploads');
const processedDir = path.join(__dirname, 'processed');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir);

// 3. Middlewares
app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(processedDir));

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

// NOVA FUNÇÃO para enviar a resposta como .zip
function sendZipResponse(res, filesToZip, filesToDelete) {
    const archive = archiver('zip', { zlib: { level: 9 } });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=resultado.zip');

    // Limpa os ficheiros temporários quando a resposta for fechada
    res.on('close', () => {
        console.log('Limpando ficheiros temporários...');
        filesToDelete.forEach(file => {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
                console.log(`Ficheiro removido: ${file}`);
            }
        });
    });

    archive.on('error', (err) => {
        throw err;
    });

    archive.pipe(res);

    filesToZip.forEach(file => {
        archive.file(file.path, { name: file.name });
    });

    archive.finalize();
}


// 5. Rotas
app.get('/', (req, res) => res.send('Backend DarkMaker está a funcionar!'));

// Cortar vídeo
app.post('/cortar-video', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).send('Nenhum ficheiro enviado.');
    const { startTime, endTime } = req.body;
    if (!startTime || !endTime) return res.status(400).send('Tempos obrigatórios.');

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
        // Limpa ficheiros em caso de erro
        files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
        res.status(500).send(e.message);
    }
});


// Unir vídeos
app.post('/unir-videos', upload.array('videos'), async (req, res) => {
  const files = req.files || [];
  if (files.length < 2) return res.status(400).send('Mínimo 2 vídeos.');

  const fileListPath = path.join(uploadDir, `list-${Date.now()}.txt`);
  const outputFilename = `unido-${Date.now()}.mp4`;
  const outputPath = path.join(processedDir, outputFilename);

  const fileContent = files
    .map(f => `file '${f.path.replace(/'/g, "'\\''")}'`)
    .join('\n');
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

// Comprimir vídeo
app.post('/comprimir-videos', upload.array('videos'), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).send('Nenhum ficheiro enviado.');
    
    const crfMap = { alta: '18', media: '23', baixa: '28' };
    const crf = crfMap[req.body.quality] || '23';

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


// Embaralhar vídeos
app.post('/embaralhar-videos', upload.array('videos'), async (req, res) => {
  const files = req.files || [];
  if (files.length < 2) return res.status(400).send('Mínimo 2 vídeos.');

  const shuffled = files.sort(() => Math.random() - 0.5);
  const fileListPath = path.join(uploadDir, `list-shuf-${Date.now()}.txt`);
  const outputFilename = `embaralhado-${Date.now()}.mp4`;
  const outputPath = path.join(processedDir, outputFilename);

  const fileContent = shuffled
    .map(f => `file '${f.path.replace(/'/g, "'\\''")}'`)
    .join('\n');
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

// Remover áudio/metadados
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


// Criar vídeo automático
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

  const filesToDelete = [
      narrationFile.path,
      ...mediaFiles.map(f => f.path),
      fileListPath,
      silentVideoPath,
      outputPath
  ];

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

    sendZipResponse(res, [{ path: outputPath, name: outputFilename }], filesToDelete);

  } catch (e) {
    filesToDelete.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    res.status(500).send(e.message);
  }
});


// 6. Iniciar Servidor
app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
