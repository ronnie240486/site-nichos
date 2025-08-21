# 1. Imagem base
FROM node:18-slim

# 2. Diretório de trabalho
WORKDIR /app

# 3. Instalar FFmpeg com suporte a frei0r e outras bibliotecas
RUN apt-get update && \
    apt-get install -y \
    ffmpeg \
    frei0r-plugins \
    libavfilter-dev \
    libavformat-dev \
    libavcodec-dev \
    libswscale-dev \
    libavutil-dev \
    libavdevice-dev \
    libswresample-dev \
    libpostproc-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 4. Copiar Ficheiros do Projeto
COPY package*.json ./

# 5. Instalar Dependências do Node.js
RUN npm install

# 6. Copiar o Resto do Código da Aplicação
COPY . .

# 7. Expor a Porta
EXPOSE 3000

# 8. Comando de Início
CMD [ "node", "server.js" ]
