// Importa as dependências necessárias
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
require('dotenv').config(); // Carrega as variáveis de ambiente do ficheiro .env

// Cria a aplicação Express
const app = express();

// Configurações do servidor
app.use(cors()); // Permite que o frontend (em outro domínio) aceda a este backend
app.use(express.json()); // Permite que o servidor entenda JSON nos corpos das requisições
app.use(express.static('public')); // Serve os ficheiros da pasta 'public' (onde ficará o index.html)

// Pega nas chaves de API guardadas em segurança no ambiente do Render
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const IMAGEN_API_KEY = process.env.IMAGEN_API_KEY;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
// A chave da kie.ai está aqui para o futuro, mas não será usada diretamente em chamadas
const KIE_API_KEY = process.env.KIE_API_KEY; 

// Função auxiliar para chamadas de API com log de erros melhorado
async function fetchWithEnhancedLogging(url, options, apiName) {
    const response = await fetch(url, options);
    if (!response.ok) {
        const errorBody = await response.text();
        console.error(`Erro na API ${apiName}: Status ${response.status}`, errorBody);
        throw new Error(`Erro na API ${apiName}. Verifique os logs do servidor no Render para detalhes.`);
    }
    return response.json();
}


// Rota para ferramentas genéricas da Gemini (texto)
app.post('/api/gemini', async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!GEMINI_API_KEY) throw new Error('Chave da API Gemini não configurada no servidor.');

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
        const data = await fetchWithEnhancedLogging(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        }, 'Gemini');
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Rota para gerar imagens com Imagen
app.post('/api/imagen', async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!IMAGEN_API_KEY) throw new Error('Chave da API Imagen não configurada no servidor.');

        const apiUrl = `https://generativelanguage.googleapis.com/v1/models/imagen-3.0-generate-002:predict?key=${IMAGEN_API_KEY}`;
        const data = await fetchWithEnhancedLogging(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instances: [{ prompt: prompt }], parameters: { "sampleCount": 1 } })
        }, 'Imagen');
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Rota para buscar vídeos no YouTube (pesquisa e shorts)
app.post('/api/youtube-search', async (req, res) => {
    try {
        const { termo, regionCode, order, videoDuration } = req.body;
        if (!YOUTUBE_API_KEY) throw new Error('Chave da API do YouTube não configurada no servidor.');

        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(termo)}&type=video&maxResults=9&key=${YOUTUBE_API_KEY}&regionCode=${regionCode}&order=${order}&videoDuration=${videoDuration}`;
        const searchData = await fetchWithEnhancedLogging(searchUrl, {}, 'YouTube Search');
        
        if (!searchData.items || searchData.items.length === 0) {
            return res.json({ items: [] });
        }

        const videoIds = searchData.items.map(item => item.id.videoId).join(',');
        const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${videoIds}&key=${YOUTUBE_API_KEY}`;
        const statsData = await fetchWithEnhancedLogging(statsUrl, {}, 'YouTube Stats');
        
        res.json(statsData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Rota para buscar vídeos em alta (trending)
app.post('/api/youtube-trending', async (req, res) => {
    try {
        const { regionCode } = req.body;
        if (!YOUTUBE_API_KEY) throw new Error('Chave da API do YouTube não configurada no servidor.');

        const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=${regionCode}&maxResults=9&key=${YOUTUBE_API_KEY}`;
        const data = await fetchWithEnhancedLogging(apiUrl, {}, 'YouTube Trending');
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Rota para analisar um vídeo por link
app.post('/api/link-analysis', async (req, res) => {
    try {
        const { videoId, prompt } = req.body;
        if (!YOUTUBE_API_KEY || !GEMINI_API_KEY) throw new Error('Chaves de API do YouTube e Gemini são necessárias.');
        
        const youtubeApiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${videoId}&key=${YOUTUBE_API_KEY}`;
        const youtubeData = await fetchWithEnhancedLogging(youtubeApiUrl, {}, 'YouTube Video Details');
        const videoData = youtubeData.items[0];

        const contextPacket = `--- CONTEXTO DO VÍDEO ---\nTítulo: ${videoData.snippet.title}\nDescrição: ${videoData.snippet.description}\nTags: ${(videoData.snippet.tags || []).join(', ')}\nVisualizações: ${videoData.statistics.viewCount}\nLikes: ${videoData.statistics.likeCount}\nComentários: ${videoData.statistics.commentCount}\n--- FIM DO CONTEXTO ---\n\nCom base no CONTEXTO DO VÍDEO fornecido acima, execute a seguinte tarefa:\n${prompt}`;

        const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
        const geminiData = await fetchWithEnhancedLogging(geminiApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: contextPacket }] }] })
        }, 'Gemini (Link Analysis)');
        
        res.json(geminiData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// Inicia o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor a correr na porta ${PORT}`);
});
