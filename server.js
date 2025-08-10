// server.js - Backend para a aplicação DarkMaker

// 1. Importação de Módulos
const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors'); // CORRIGIDO: Removidas as aspas de 'require'

// 2. Configuração Inicial
const app = express();
const PORT = process.env.PORT || 10000;

// Cria as pastas se não existirem
const uploadDir = path.join(__dirname, 'uploads');
const processedDir = path.join(__dirname, 'processed');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir);

// 3. Middlewares
app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(processedDir)); // Permite o download dos ficheiros processados

// Configuração do Multer para guardar os ficheiros com nomes únicos
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s/g, '_')}`)
});
const upload = multer({ storage: storage });

// 4. Funções Auxiliares
function runFFmpeg(command) {
  return new Promise((resolve, reject) => {
    console.log(`Executando FFmpeg: ${command}`);
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`FFmpeg Stderr: ${stderr}`);
        return reject(new Error(`Erro no FFmpeg: ${stderr}`));
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
  if (!req.file) return res.status(400).send('Nenhum ficheiro de vídeo enviado.');
  const { startTime, endTime } = req.body;
  if (!startTime || !endTime) return res.status(400).send('Tempos de início e fim são obrigatórios.');

  const inputPath = req.file.path;
  const outputFilename = `cortado-${req.file.filename}`;
  const outputPath = path.join(processedDir, outputFilename);
  const command = `ffmpeg -i "${inputPath}" -ss ${startTime} -to ${endTime} -c copy "${outputPath}"`;

  try {
    await runFFmpeg(command);
    res.download(outputPath, outputFilename, (err) => {
      if (err) console.error("Erro ao enviar o ficheiro:", err);
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    });
  } catch (error) {
    res.status(500).send(error.message);
    fs.unlinkSync(inputPath);
  }
});

// Rota para Unir Vídeos
app.post('/unir-videos', upload.array('videos'), async (req, res) => {
  if (!req.files || req.files.length < 2) return res.status(400).send('Pelo menos dois vídeos são necessários para unir.');

  const fileListPath = path.join(uploadDir, `list-${Date.now()}.txt`);
  const fileContent = req.files.map(f => `file '${f.path}'`).join('\n');
  fs.writeFileSync(fileListPath, fileContent);

  const outputFilename = `unido-${Date.now()}.mp4`;
  const outputPath = path.join(processedDir, outputFilename);
  const command = `ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy "${outputPath}"`;

  try {
    await runFFmpeg(command);
    res.download(outputPath, outputFilename, (err) => {
      if (err) console.error("Erro ao enviar o ficheiro:", err);
      req.files.forEach(f => fs.unlinkSync(f.path));
      fs.unlinkSync(fileListPath);
      fs.unlinkSync(outputPath);
    });
  } catch (error) {
    res.status(500).send(error.message);
    req.files.forEach(f => fs.unlinkSync(f.path));
    fs.unlinkSync(fileListPath);
  }
});

// Rota para Comprimir Vídeo
app.post('/comprimir-videos', upload.single('videos'), async (req, res) => {
    if (!req.file) return res.status(400).send('Nenhum ficheiro enviado.');
    const { quality } = req.body;
    const crfMap = { alta: '18', media: '23', baixa: '28' };
    const crf = crfMap[quality] || '23';

    const inputPath = req.file.path;
    const outputFilename = `comprimido-${req.file.filename}`;
    const outputPath = path.join(processedDir, outputFilename);
    const command = `ffmpeg -i "${inputPath}" -vcodec libx264 -crf ${crf} "${outputPath}"`;

    try {
        await runFFmpeg(command);
        res.download(outputPath, outputFilename, (err) => {
            if (err) console.error("Erro ao enviar o ficheiro:", err);
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
        });
    } catch (error) {
        res.status(500).send(error.message);
        fs.unlinkSync(inputPath);
    }
});

// Rota para Embaralhar Vídeos
app.post('/embaralhar-videos', upload.array('videos'), async (req, res) => {
    if (!req.files || req.files.length < 2) return res.status(400).send('Pelo menos dois vídeos são necessários para embaralhar.');

    let shuffledFiles = req.files.sort(() => Math.random() - 0.5);

    const fileListPath = path.join(uploadDir, `list-embaralhada-${Date.now()}.txt`);
    const fileContent = shuffledFiles.map(f => `file '${f.path}'`).join('\n');
    fs.writeFileSync(fileListPath, fileContent);

    const outputFilename = `embaralhado-${Date.now()}.mp4`;
    const outputPath = path.join(processedDir, outputFilename);
    const command = `ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy "${outputPath}"`;

    try {
        await runFFmpeg(command);
        res.download(outputPath, outputFilename, (err) => {
            if (err) console.error("Erro ao enviar o ficheiro:", err);
            req.files.forEach(f => fs.unlinkSync(f.path));
            fs.unlinkSync(fileListPath);
            fs.unlinkSync(outputPath);
        });
    } catch (error) {
        res.status(500).send(error.message);
        req.files.forEach(f => fs.unlinkSync(f.path));
        fs.unlinkSync(fileListPath);
    }
});

// Rota para Remover Áudio e/ou Metadados
app.post('/remover-audio', upload.single('videos'), async (req, res) => {
    if (!req.file) return res.status(400).send('Nenhum ficheiro enviado.');
    
    const { removeAudio, removeMetadata } = req.body;
    const inputPath = req.file.path;
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
        return res.status(400).send('Nenhuma opção de remoção selecionada.');
    }

    const command = `ffmpeg -i "${inputPath}" ${flags} "${outputPath}"`;

    try {
        await runFFmpeg(command);
        res.download(outputPath, outputFilename, (err) => {
            if (err) console.error("Erro ao enviar o ficheiro:", err);
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
        });
    } catch (error) {
        res.status(500).send(error.message);
        fs.unlinkSync(inputPath);
    }
});

// Rota para Criar Vídeo Automático
app.post('/criar-video-automatico', upload.fields([
  { name: 'narration', maxCount: 1 },
  { name: 'media', maxCount: 50 }
]), async (req, res) => {
  console.log('Recebido pedido para /criar-video-automatico');

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

  try {
    const audioDuration = await getMediaDuration(narrationFile.path);
    const durationPerImage = audioDuration / mediaFiles.length;

    const fileListPath = path.join(uploadDir, `list-auto-${Date.now()}.txt`);
    tempFiles.push(fileListPath);
    const fileContent = mediaFiles.map(f => `file '${f.path}'\nduration ${durationPerImage}`).join('\n');
    fs.writeFileSync(fileListPath, fileContent);

    const silentVideoPath = path.join(processedDir, `silent-${Date.now()}.mp4`);
    tempFiles.push(silentVideoPath);
    const createSilentVideoCmd = `ffmpeg -f concat -safe 0 -i "${fileListPath}" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -c:v libx264 -r 25 -y "${silentVideoPath}"`;
    await runFFmpeg(createSilentVideoCmd);

    const outputFilename = `automatico-${Date.now()}.mp4`;
    const outputPath = path.join(processedDir, outputFilename);
    const addAudioCmd = `ffmpeg -i "${silentVideoPath}" -i "${narrationFile.path}" -c:v copy -c:a aac -shortest "${outputPath}"`;
    await runFFmpeg(addAudioCmd);
    
    tempFiles.push(outputPath);

    res.download(outputPath, outputFilename, (err) => {
      if (err) console.error("Erro ao enviar o ficheiro:", err);
      cleanup();
    });

  } catch (error) {
    cleanup();
    res.status(500).send(error.message);
  }
});


// 6. Iniciar o Servidor
app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`FFmpeg Stderr: ${stderr}`);
        return reject(new Error(`Erro no FFmpeg: ${stderr}`));
      }
      console.log(`FFmpeg Stdout: ${stdout}`);
      resolve('Processamento FFmpeg concluído com sucesso.');
    });
  });
}

// 5. Rotas da API
app.get('/', (req, res) => res.send('Backend DarkMaker está a funcionar!'));

// Rota para Cortar Vídeo
app.post('/cortar-video', upload.single('videos'), async (req, res) => {
  if (!req.file) return res.status(400).send('Nenhum ficheiro de vídeo enviado.');
  const { startTime, endTime } = req.body;
  if (!startTime || !endTime) return res.status(400).send('Tempos de início e fim são obrigatórios.');

  const inputPath = req.file.path;
  const outputFilename = `cortado-${req.file.filename}`;
  const outputPath = path.join(processedDir, outputFilename);
  const command = `ffmpeg -i "${inputPath}" -ss ${startTime} -to ${endTime} -c copy "${outputPath}"`;

  try {
    await runFFmpeg(command);
    res.download(outputPath, outputFilename, (err) => {
        if (err) console.error("Erro ao enviar o ficheiro:", err);
        fs.unlinkSync(inputPath); // Limpa o upload
        fs.unlinkSync(outputPath); // Limpa o ficheiro processado após o download
    });
  } catch (error) {
    res.status(500).send(error.message);
    fs.unlinkSync(inputPath); // Limpa o upload em caso de erro
  }
});

// Rota para Unir Vídeos
app.post('/unir-videos', upload.array('videos'), async (req, res) => {
  if (!req.files || req.files.length < 2) return res.status(400).send('Pelo menos dois vídeos são necessários para unir.');

  const fileListPath = path.join(uploadDir, `list-${Date.now()}.txt`);
  const fileContent = req.files.map(f => `file '${f.path}'`).join('\n');
  fs.writeFileSync(fileListPath, fileContent);

  const outputFilename = `unido-${Date.now()}.mp4`;
  const outputPath = path.join(processedDir, outputFilename);
  const command = `ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy "${outputPath}"`;

  try {
    await runFFmpeg(command);
    res.download(outputPath, outputFilename, (err) => {
        if (err) console.error("Erro ao enviar o ficheiro:", err);
        req.files.forEach(f => fs.unlinkSync(f.path)); // Limpa uploads
        fs.unlinkSync(fileListPath); // Limpa ficheiro de lista
        fs.unlinkSync(outputPath); // Limpa processado
    });
  } catch (error) {
    res.status(500).send(error.message);
    req.files.forEach(f => fs.unlinkSync(f.path));
    fs.unlinkSync(fileListPath);
  }
});

// Rota para Comprimir Vídeo
app.post('/comprimir-videos', upload.single('videos'), async (req, res) => {
    if (!req.file) return res.status(400).send('Nenhum ficheiro enviado.');
    const { quality } = req.body;
    const crfMap = { alta: '18', media: '23', baixa: '28' };
    const crf = crfMap[quality] || '23';

    const inputPath = req.file.path;
    const outputFilename = `comprimido-${req.file.filename}`;
    const outputPath = path.join(processedDir, outputFilename);
    const command = `ffmpeg -i "${inputPath}" -vcodec libx264 -crf ${crf} "${outputPath}"`;

    try {
        await runFFmpeg(command);
        res.download(outputPath, outputFilename, (err) => {
            if (err) console.error("Erro ao enviar o ficheiro:", err);
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
        });
    } catch (error) {
        res.status(500).send(error.message);
        fs.unlinkSync(inputPath);
    }
});

// Rota para Embaralhar Vídeos
app.post('/embaralhar-videos', upload.array('videos'), async (req, res) => {
    if (!req.files || req.files.length < 2) return res.status(400).send('Pelo menos dois vídeos são necessários para embaralhar.');

    // Algoritmo para embaralhar a lista de ficheiros
    let shuffledFiles = req.files.sort(() => Math.random() - 0.5);

    const fileListPath = path.join(uploadDir, `list-embaralhada-${Date.now()}.txt`);
    const fileContent = shuffledFiles.map(f => `file '${f.path}'`).join('\n');
    fs.writeFileSync(fileListPath, fileContent);

    const outputFilename = `embaralhado-${Date.now()}.mp4`;
    const outputPath = path.join(processedDir, outputFilename);
    const command = `ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy "${outputPath}"`;

    try {
        await runFFmpeg(command);
        res.download(outputPath, outputFilename, (err) => {
            if (err) console.error("Erro ao enviar o ficheiro:", err);
            req.files.forEach(f => fs.unlinkSync(f.path));
            fs.unlinkSync(fileListPath);
            fs.unlinkSync(outputPath);
        });
    } catch (error) {
        res.status(500).send(error.message);
        req.files.forEach(f => fs.unlinkSync(f.path));
        fs.unlinkSync(fileListPath);
    }
});


// Rota para Remover Áudio e/ou Metadados
app.post('/remover-audio', upload.single('videos'), async (req, res) => {
    if (!req.file) return res.status(400).send('Nenhum ficheiro enviado.');
    
    const { removeAudio, removeMetadata } = req.body;
    const inputPath = req.file.path;
    const outputFilename = `processado-${req.file.filename}`;
    const outputPath = path.join(processedDir, outputFilename);

    let flags = '-c copy'; // Copia os streams de vídeo e áudio por defeito para ser mais rápido
    if (removeAudio === 'true') {
        flags += ' -an'; // Flag para remover o áudio (-an = no audio)
    }
    if (removeMetadata === 'true') {
        flags += ' -map_metadata -1'; // Flag para remover todos os metadados
    }

    if (flags === '-c copy') {
        return res.status(400).send('Nenhuma opção de remoção selecionada.');
    }

    const command = `ffmpeg -i "${inputPath}" ${flags} "${outputPath}"`;

    try {
        await runFFmpeg(command);
        res.download(outputPath, outputFilename, (err) => {
            if (err) console.error("Erro ao enviar o ficheiro:", err);
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
        });
    } catch (error) {
        res.status(500).send(error.message);
        fs.unlinkSync(inputPath);
    }
});


// 6. Iniciar o Servidor
app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
});

