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
const PORT = process.env.PORT || 3000;

// Cria as pastas se não existirem
const uploadDir = path.join(__dirname, 'uploads');
const processedDir = path.join(__dirname, 'processed');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir);

// 3. Middlewares
app.use(cors()); 
app.use('/downloads', express.static(processedDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage: storage });

// 4. Função Auxiliar para FFmpeg
function runFFmpeg(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`FFmpeg Error: ${stderr}`);
        return reject(new Error(`Erro no FFmpeg: ${stderr}`));
      }
      resolve('Processamento FFmpeg concluído com sucesso.');
    });
  });
}

// 5. Rotas da API
app.get('/', (req, res) => res.send('Backend DarkMaker está a funcionar!'));

app.post('/api/cortar', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).send('Nenhum ficheiro de vídeo enviado.');
  const { startTime, endTime } = req.body;
  if (!startTime || !endTime) return res.status(400).send('Tempos de início e fim são obrigatórios.');

  const inputPath = req.file.path;
  const outputFilename = `cortado-${req.file.filename}`;
  const outputPath = path.join(processedDir, outputFilename);
  const command = `ffmpeg -i "${inputPath}" -ss ${startTime} -to ${endTime} -c copy "${outputPath}"`;

  try {
    await runFFmpeg(command);
    const downloadUrl = `${req.protocol}://${req.get('host')}/downloads/${outputFilename}`;
    res.json({ message: 'Vídeo cortado com sucesso!', downloadUrl });
  } catch (error) {
    res.status(500).send(error.message);
  } finally {
    fs.unlinkSync(inputPath);
  }
});

app.post('/api/unir', upload.array('videos'), async (req, res) => {
  if (!req.files || req.files.length < 2) return res.status(400).send('Pelo menos dois vídeos são necessários para unir.');

  const fileListPath = path.join(uploadDir, `list-${Date.now()}.txt`);
  const fileContent = req.files.map(f => `file '${f.path}'`).join('\n');
  fs.writeFileSync(fileListPath, fileContent);

  const outputFilename = `unido-${Date.now()}.mp4`;
  const outputPath = path.join(processedDir, outputFilename);
  const command = `ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy "${outputPath}"`;

  try {
    await runFFmpeg(command);
    const downloadUrl = `${req.protocol}://${req.get('host')}/downloads/${outputFilename}`;
    res.json({ message: 'Vídeos unidos com sucesso!', downloadUrl });
  } catch (error) {
    res.status(500).send(error.message);
  } finally {
    req.files.forEach(f => fs.unlinkSync(f.path));
    fs.unlinkSync(fileListPath);
  }
});

// 6. Iniciar o Servidor
app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});