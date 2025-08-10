// server.js - Backend DarkMaker com proteção contra ENOTDIR

const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

// === Função para criar diretório ou corrigir conflito ===
function ensureDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    if (!fs.lstatSync(dirPath).isDirectory()) {
      fs.unlinkSync(dirPath); // apaga arquivo com o mesmo nome
      fs.mkdirSync(dirPath, { recursive: true });
    }
  } else {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Cria ou corrige as pastas necessárias
const uploadDir = path.join(__dirname, 'uploads');
const processedDir = path.join(__dirname, 'processed');
ensureDir(uploadDir);
ensureDir(processedDir);

// Função segura para deletar arquivos
function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error(`Erro ao deletar ${filePath}:`, err.message);
  }
}

// Middlewares
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

// Funções auxiliares
function runFFmpeg(command, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\x1b[36m[FFmpeg]\x1b[0m Executando: ${command}`);
    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        console.error(`\x1b[31m[FFmpeg Error]\x1b[0m ${stderr}`);
        return reject(new Error(stderr || 'Erro desconhecido no FFmpeg'));
      }
      console.log(`\x1b[32m[FFmpeg OK]\x1b[0m`);
      resolve();
    });
  });
}

function getMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
    exec(command, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr));
      resolve(parseFloat(stdout));
    });
  });
}

// Rotas
app.get('/', (req, res) => res.send('Backend DarkMaker está rodando!'));

// === Exemplo: unir vídeos com segurança ===
app.post('/unir-videos', upload.array('videos'), async (req, res) => {
  const files = req.files || [];
  if (files.length < 2) return res.status(400).send('Mínimo 2 vídeos.');

  const fileListPath = path.join(uploadDir, `list-${Date.now()}.txt`);
  const outputPath = path.join(processedDir, `unido-${Date.now()}.mp4`);

  const fileContent = files
    .map(f => `file '${f.path.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(fileListPath, fileContent);

  try {
    await runFFmpeg(`ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy "${outputPath}"`);
    res.download(outputPath, () => {
      files.forEach(f => safeUnlink(f.path));
      safeUnlink(fileListPath);
      safeUnlink(outputPath);
    });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// TODO: repetir a mesma lógica (safeUnlink + ensureDir) para as outras rotas

app.listen(PORT, () => {
  console.log(`\x1b[35m[Servidor]\x1b[0m Rodando na porta ${PORT}`);
});
