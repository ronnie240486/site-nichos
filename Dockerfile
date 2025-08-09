# 1. Imagem Base
FROM node:18-slim

# 2. Definir o Diretório de Trabalho
WORKDIR /app

# 3. Instalar o FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

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