# Pakai image resmi Playwright yang browser Chromium-nya sudah terpasang,
# supaya tidak perlu urus instalasi dependency browser secara manual.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
