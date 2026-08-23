# ShopeeGrab API — panduan lengkap

Backend kecil ini yang membuat tombol download di template Blogger kamu
benar-benar berfungsi (bukan cuma mode demo). File ini menjelaskan
langkah demi langkah dari nol.

## Gambaran besar: kenapa perlu ini?

Blogger cuma bisa menjalankan HTML/CSS/JS statis di browser pengunjung.
Untuk mengambil video dari halaman Shopee, dibutuhkan proses yang:

1. Membuka link video Shopee (seperti browser sungguhan membukanya).
2. Menemukan file video aslinya (biasanya `.mp4`, kadang `.m3u8`).
3. Mengirimkan file itu ke pengunjung dengan header yang memicu
   "Save As" / unduhan otomatis (bukan cuma memutar videonya).

Proses ini **tidak bisa** dilakukan oleh JavaScript di browser pengunjung
saja (diblokir kebijakan CORS oleh Shopee), jadi harus dijalankan di
server terpisah — itulah backend ini.

Alurnya:

```
Pengunjung tempel link  ->  Blogger (frontend, sudah kamu punya)
                              |  fetch(SHOPEE_API_ENDPOINT + '?url=...')
                              v
                    Server INI (backend, panduan ini)
                              |  buka halaman Shopee pakai browser headless,
                              |  "nguping" file video yang benar-benar dimuat
                              v
                    Kembalikan link download ke Blogger
                              |
                              v
                    Pengunjung klik "Simpan Video" -> file terunduh
```

## Yang perlu kamu tahu sebelum mulai

- Pendekatan di `server.js` memakai **browser headless sungguhan**
  (Playwright) untuk membuka halaman video Shopee dan menangkap file
  video yang benar-benar dimuat — bukan menebak-nebak endpoint API
  internal Shopee. Ini lebih tahan terhadap perubahan struktur Shopee,
  tapi tetap **butuh kamu uji coba sendiri** dengan link video Shopee
  yang asli, karena struktur halaman Shopee bisa berbeda-beda tergantung
  jenis kontennya (video di feed, video di halaman produk, live
  replay, dll) dan bisa berubah sewaktu-waktu.
- Kalau ternyata videonya berformat `.m3u8` (HLS/streaming per-segmen)
  bukan `.mp4` utuh, ada langkah tambahan yang diperlukan (dijelaskan
  di komentar `TODO` paling bawah `server.js`).
- Menyalin & mendistribusikan ulang video dari platform lain punya
  implikasi hak cipta & Ketentuan Layanan Shopee — pastikan penggunaanmu
  wajar (personal/edukasi/afiliasi dengan kredit ke pembuat asli),
  sesuai yang sudah dituliskan di FAQ & footer template.

## Langkah 1 — Coba jalankan di komputer sendiri dulu

1. Install [Node.js](https://nodejs.org) versi 18 ke atas kalau belum ada.
2. Buka folder `backend/` ini di terminal, lalu jalankan:
   ```
   npm install
   npx playwright install --with-deps chromium
   npm start
   ```
3. Server akan jalan di `http://localhost:3000`. Coba buka di browser:
   ```
   http://localhost:3000/api/shopee-extract?url=<tempel_link_video_shopee_asli>
   ```
4. Kalau berhasil, akan muncul JSON berisi `title`, `duration`, `size`,
   dan `downloadUrl`. Kalau muncul error "Tidak menemukan file video",
   lanjut ke Langkah 2 untuk menyesuaikan kodenya.

## Langkah 2 — Inspeksi manual pakai DevTools (kalau Langkah 1 belum berhasil)

Karena struktur halaman Shopee tidak saya ketahui persis saat ini, kamu
perlu memverifikasinya sendiri:

1. Buka Chrome di HP atau desktop, buka link video Shopee yang ingin
   diuji.
2. Tekan `F12` (atau klik kanan > Inspect) untuk buka DevTools, lalu
   buka tab **Network**.
3. Filter dengan mengetik `.mp4` atau pilih filter **Media**.
4. Putar videonya (kalau belum otomatis putar). Perhatikan request apa
   yang muncul — catat URL-nya, apakah `.mp4` atau `.m3u8`, dan apakah
   videonya baru muncul setelah kamu klik sesuatu (tombol play, dsb).
5. Kalau videonya baru muncul setelah klik elemen tertentu, klik kanan
   elemen itu di tab **Elements**, lalu sesuaikan selector di
   `server.js` pada bagian:
   ```js
   await page.click('video, [class*="play"], [aria-label*="play" i]', ...)
   ```
   ganti dengan selector yang lebih spesifik sesuai temuanmu.

## Langkah 3 — Deploy supaya bisa diakses publik

Blogger butuh URL publik (bukan `localhost`) untuk `SHOPEE_API_ENDPOINT`.
Karena backend ini memakai Playwright (butuh browser Chromium beneran),
platform **serverless ringan** seperti Vercel/Cloudflare Workers **tidak
cocok**. Rekomendasi: [Render.com](https://render.com) (ada free/murah
tier, mendukung Docker) atau [Railway.app](https://railway.app).

**Deploy ke Render.com (pakai Docker, paling gampang):**

1. Push folder `backend/` ini ke sebuah repo GitHub baru.
2. Di Render.com, klik **New > Web Service**, hubungkan ke repo tadi.
3. Render otomatis mendeteksi `Dockerfile` yang sudah disediakan di
   folder ini — pilih **Docker** sebagai environment.
4. Di bagian **Environment Variables**, tambahkan:
   - `PUBLIC_BASE_URL` = URL yang nanti diberikan Render ke servicemu
     (contoh: `https://shopeegrab-api.onrender.com`) — isi ini
     **setelah** deploy pertama selesai dan kamu tahu URL-nya, lalu
     redeploy.
5. Klik **Create Web Service** dan tunggu proses build selesai.
6. Setelah jalan, tes lagi seperti Langkah 1 tapi pakai URL Render-mu.

## Langkah 4 — Sambungkan ke template Blogger

1. Buka file tema `shopee-video-downloader-template.xml` di editor teks.
2. Cari baris:
   ```js
   var SHOPEE_API_ENDPOINT = '';
   ```
3. Isi dengan URL backend kamu + `/api/shopee-extract`, contoh:
   ```js
   var SHOPEE_API_ENDPOINT = 'https://shopeegrab-api.onrender.com/api/shopee-extract';
   ```
4. Simpan, lalu upload ulang temanya ke Blogger (Tema > Edit HTML).
5. Buka blog kamu, tempel link video Shopee asli, klik Download —
   kalau backend sudah benar, kartu hasil akan muncul TANPA label
   "Mode demo", dan tombol "Simpan Video Tanpa Watermark" akan benar-
   benar mengunduh file videonya.

## Biaya & batasan yang perlu diperhatikan

- Setiap kali ada yang klik download, servermu membuka browser headless
  (agak berat) dan men-stream ulang file videonya (memakai bandwidth
  server). Kalau trafiknya ramai, pertimbangkan paket hosting yang
  lebih besar dari free tier.
- Free tier Render biasanya "tidur" kalau tidak ada trafik dan perlu
  waktu beberapa detik untuk "bangun" lagi saat ada request pertama —
  wajar kalau permintaan pertama terasa lambat.
- Shopee bisa saja mengubah struktur halamannya kapan saja, yang bisa
  membuat ekstraksi berhenti berfungsi sampai `server.js` disesuaikan
  ulang mengikuti Langkah 2 di atas.
