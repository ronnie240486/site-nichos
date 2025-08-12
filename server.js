// Criar vídeo automático
app.post('/criar-video-automatico', upload.fields([
  { name: 'narration', maxCount: 1 },
  { name: 'media', maxCount: 50 }
]), async (req, res) => {
  try {
    const narrationFile = req.files?.narration?.[0];
    const mediaFiles = req.files?.media || [];

    if (!narrationFile || mediaFiles.length === 0) {
      return res.status(400).send('Narração e pelo menos um ficheiro de media são obrigatórios.');
    }

    const narrationPath = narrationFile.path;
    const outputVideo = `video_${Date.now()}.mp4`;
    const tempListFile = `file_list_${Date.now()}.txt`;

    // Criar lista de imagens para FFmpeg
    const fs = require('fs');
    const fileListContent = mediaFiles
      .map(file => `file '${file.path}'\nduration 5`)
      .join('\n');

    fs.writeFileSync(tempListFile, fileListContent);

    // Comando FFmpeg para criar o vídeo
    const { exec } = require('child_process');
    const ffmpegCmd = `ffmpeg -y -f concat -safe 0 -i ${tempListFile} -i ${narrationPath} -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest ${outputVideo}`;

    exec(ffmpegCmd, (err, stdout, stderr) => {
      // Remover arquivos temporários
      fs.unlinkSync(tempListFile);
      mediaFiles.forEach(file => fs.unlinkSync(file.path));

      if (err) {
        console.error('Erro no FFmpeg:', stderr);
        return res.status(500).send('Erro ao criar vídeo automático.');
      }

      console.log('Vídeo criado:', outputVideo);
      res.download(outputVideo, () => {
        fs.unlinkSync(outputVideo);
        fs.unlinkSync(narrationPath);
      });
    });

  } catch (error) {
    console.error('Erro inesperado:', error);
    res.status(500).send('Erro interno do servidor.');
  }
});
