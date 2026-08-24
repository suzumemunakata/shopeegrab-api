# Pakai image resmi Playwright yang browser Chromium-nya sudah terpasang,
# supaya tidak perlu urus instalasi dependency browser secara manual.
#
# PENTING: tag versi di sini (v1.62.1-jammy) HARUS SAMA PERSIS dengan versi
# "playwright" di package.json (exact-pin, tanpa "^"), atau nanti muncul
# lagi error "Executable doesn't exist ... current vX, required vY" seperti
# yang pernah terjadi sebelumnya. Kalau suatu saat package.json di-update ke
# versi Playwright lain, baris FROM ini juga WAJIB diupdate ke tag yang sama.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

# ffmpeg dipakai server.js untuk memproses video (menghilangkan watermark
# Shopee yang dibakar ke video: mengaburkan badge logo di pojok + memotong
# outro/end-card Shopee di akhir video) sebelum dikirim ke pengguna lewat
# /api/download dan /api/stream. Image dasar di atas berbasis Ubuntu/Debian
# (jammy), jadi bisa pasang lewat apt-get.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
