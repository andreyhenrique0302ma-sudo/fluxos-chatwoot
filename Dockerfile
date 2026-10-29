FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# dados (fluxos, mídias, pacientes) ficam em /app/data: monte um volume aí
ENV DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "server.js"]
