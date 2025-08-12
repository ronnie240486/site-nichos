// server.js - Fluxo completo: yt-dlp -> whisper (OpenAI) -> reescrita (OpenAI) -> ElevenLabs TTS -> FFmpeg
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 10000;

// --- Helpers: ensure dir + safe unlink ---
function ensureDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    if (!fs.lstatSync(dirPath).isDirectory()) {
      fs.unlinkSync(dirPath);
      fs.mkdirSync(dirPath, { recursive: true });
    }
  } else {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}
function safeUnlink(p) {
  try { if (p && fs.existsSync(p) && fs.lstatSync(p).isFile()) fs.unlinkSync(p); } catch (e) { console.error('safeUnlink failed', p, e.message); }
}

// --- Temporários (use /tmp para Render) ---
const TMP = process.env.TMPDIR || '/tmp';
const UPLOAD_DIR = path.join(TMP, 'darkmaker_uploads');
const PROCESS_DIR = path.join(TMP, 'darkmaker_processed');
ensureDir(UPLOAD_DIR);
ensureDir(PROCESS_DIR);

// --- Multer (salva em /tmp) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const name = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${name}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024 } }); // 1GB limite (ajuste)

// --- Exec util ---
function runCmd(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    console.log('[CMD]', cmd);
    exec(cmd, opts, (err, stdout, stderr) => {
      if (err) {
        console.error('[CMD ERR]', stderr || err.message);
        return reject(new Error(stderr || err.message));
      }
      resolve({ stdout, stderr });
    });
  });
}

// --- OpenAI transcription (Whisper) via API v1/audio/transcriptions ---
async function transcribeWithOpenAI(filePath) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('model', 'whisper-1'); // se a conta tiver este modelo
  // se quiser idioma fixo: form.append('language', 'pt');

  const res = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });
  return res.data.text || '';
}

// --- OpenAI chat rewrite (exemplo com chat completions em endpoint moderno) ---
async function rewriteTextWithOpenAI(promptText) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
  // Simples prompt: reescreve como roteiro curto e chamativo
  const system = "Você transforma uma transcrição em roteiro curto e direto, com frases curtas para vídeo, pontos principais e CTA no final.";
  const user = `Transcrição:\n${promptText}\n\nResponda com o roteiro reescrito.`;
  const payload = {
    model: 'gpt-4o-mini', // use o modelo disponível na sua conta; substitua se necessário
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    max_tokens: 800
  };
  const res = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
  });
  const text = res.data?.choices?.[0]?.message?.content;
  return text || promptText;
}

// --- ElevenLabs TTS (gera arquivo mp3) ---
async function generateVoiceWithEleven(text, outPath, voice = 'Rachel') {
  if (!process.env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY missing');
  // ElevenLabs API: https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
  // Primeiro, obter voice_id ou usar um preset. Aqui assumimos que voice param é ID or name - user must map.
  // Simples implementation: use voice ID in env or default voice id.
  const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || voice; // set voice id in env ideally
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  const response = await axios.post(url, { text }, {
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json'
    },
    responseType: 'arraybuffer'
  });
  fs.writeFileSync(outPath, response.data);
  return outPath;
}

// --- Endpoint integrado: recebe youtubeUrl OR narration audio + media images ---
// fields:
// - youtubeUrl (form field string) OR narration (file)
// - media (images files, optional)
// - useEleven = 'true' to synthesize voice from rewritten script
app.post('/criar-video-automatico-integrado', upload.fields([
  { name: 'narration', maxCount: 1 },
  { name: 'media', maxCount: 50 }
]), async (req, res) => {
  const tempFiles = []; // para limpeza
  try {
    const youtubeUrl = (req.body.youtubeUrl || '').trim();
    let narrationFile = req.files?.narration?.[0] || null;
    const mediaFiles = req.files?.media || [];

    // 1) Se veio youtubeUrl, baixar áudio com yt-dlp
    if (youtubeUrl) {
      const outAudio = path.join(UPLOAD_DIR, `yt_audio_${Date.now()}.mp3`);
      // yt-dlp command: baixa e converte direto para mp3
      // necessita yt-dlp + ffmpeg instalados no container
      const safeUrl = youtubeUrl.replace(/"/g, '\\"');
      const cmd = `yt-dlp --no-playlist -x --audio-format mp3 -o "${outAudio}" "${safeUrl}"`;
      await runCmd(cmd);
      // yt-dlp pode gerar com outro nome; procurar o arquivo gerado - vamos assumir outAudio existe
      narrationFile = { path: outAudio, filename: path.basename(outAudio) };
      tempFiles.push(outAudio);
    }

    if (!narrationFile) return res.status(400).send('Envie youtubeUrl ou ficheiro de narração.');

    // 2) Transcrever narração (Whisper)
    console.log('Transcrevendo áudio em:', narrationFile.path);
    const transcription = await transcribeWithOpenAI(narrationFile.path);
    console.log('Transcrição obtida (trecho):', transcription.slice(0, 200));

    // 3) Reescrever transcrição com OpenAI (r eadability / roteiro)
    const rewritten = await rewriteTextWithOpenAI(transcription);
    console.log('Roteiro reescrito (trecho):', rewritten.slice(0, 200));

    // 4) Gerar voz sintetizada (opcional)
    const useEleven = req.body.useEleven === 'true';
    let finalAudioPath = narrationFile.path;
    if (useEleven) {
      const ttsOut = path.join(PROCESS_DIR, `tts_${Date.now()}.mp3`);
      await generateVoiceWithEleven(rewritten, ttsOut);
      finalAudioPath = ttsOut;
      tempFiles.push(ttsOut);
    }

    // 5) Montar imagens em vídeo silencioso
    // Se o usuário enviou imagens, usamos. Caso contrário, tentamos gerar frames (não implementado aqui).
    if (mediaFiles.length === 0) {
      // fallback: criar a imagem a partir do texto (simples) - aqui cria uma imagem PNG com texto via imagem simples
      // vamos criar 1 imagem com o título do roteiro (dependência: native canvas not required; cria imagem básica com ffmpeg color + drawtext)
      const imgPath = path.join(UPLOAD_DIR, `img_${Date.now()}.png`);
      // cria imagem PNG preta com texto usando ffmpeg drawtext (requer font disponível)
      const title = (rewritten.split('\n')[0] || 'Video').replace(/"/g, '\\"');
      const cmdImg = `ffmpeg -y -f lavfi -i color=c=black:s=1920x1080 -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${title}':fontcolor=white:fontsize=60:x=(w-text_w)/2:y=(h-text_h)/2" -frames:v 1 "${imgPath}"`;
      await runCmd(cmdImg);
      mediaFiles.push({ path: imgPath });
      tempFiles.push(imgPath);
    }

    // criar file list para concat com duration baseado no tempo do áudio
    const audioDurationRes = await runCmd(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${finalAudioPath}"`);
    const audioDuration = parseFloat(audioDurationRes.stdout || audioDurationRes.stderr || '0') || 0;
    const durationPerImage = Math.max(2, audioDuration / Math.max(1, mediaFiles.length)); // mínimo 2s
    const listPath = path.join(UPLOAD_DIR, `list_${Date.now()}.txt`);
    const listContent = mediaFiles.map(f => `file '${f.path.replace(/'/g, "'\\''")}'\nduration ${durationPerImage}`).join('\n') + `\nfile '${mediaFiles[mediaFiles.length-1].path.replace(/'/g, "'\\''")}'`;
    fs.writeFileSync(listPath, listContent);
    tempFiles.push(listPath);

    // criar silent video a partir das imagens
    const silentVideo = path.join(PROCESS_DIR, `silent_${Date.now()}.mp4`);
    const createSilentCmd = `ffmpeg -y -f concat -safe 0 -i "${listPath}" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -c:v libx264 -r 25 "${silentVideo}"`;
    await runCmd(createSilentCmd);
    tempFiles.push(silentVideo);

    // juntar audio final ao silent video
    const outputVideo = path.join(PROCESS_DIR, `final_${Date.now()}.mp4`);
    const mergeCmd = `ffmpeg -y -i "${silentVideo}" -i "${finalAudioPath}" -c:v copy -c:a aac -shortest "${outputVideo}"`;
    await runCmd(mergeCmd);
    tempFiles.push(outputVideo);

    // responder com link (ou download direto)
    // aqui enviamos o arquivo para download direto
    res.download(outputVideo, path.basename(outputVideo), (err) => {
      // cleanup
      tempFiles.forEach(p => safeUnlink(p));
      if (narrationFile && narrationFile.path && !useEleven) safeUnlink(narrationFile.path);
      if (err) console.error('Erro res.download:', err.message);
    });

  } catch (err) {
    console.error('Erro /criar-video-automatico-integrado:', err.message || err);
    // cleanup partials
    // try to cleanup created tmp files in UPLOAD_DIR and PROCESS_DIR older than this run (simple)
    res.status(500).send(`Erro interno: ${err.message || err}`);
  }
});

// health
app.get('/', (req, res) => res.send('ok'));

// global error handlers
process.on('uncaughtException', e => console.error('uncaughtException', e));
process.on('unhandledRejection', e => console.error('unhandledRejection', e));

app.listen(PORT, () => console.log(`Server rodando na porta ${PORT}`));
