# 1. Imagem Base
FROM node:18-slim

# 2. Diretório de Trabalho
WORKDIR /app

# 3. Instalar FFmpeg + frei0r-plugins + dependências básicas
RUN apt-get update && \
    apt-get install -y ffmpeg frei0r-plugins && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 4. Copiar package.json e instalar dependências Node
COPY package*.json ./
RUN npm install

# 5. Copiar restante do código
COPY . .

# 6. Expor porta
EXPOSE 3000

# 7. Comando de início
CMD [ "node", "server.js" ]
