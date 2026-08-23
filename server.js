/**
 * ShopeeGrab API — backend ekstraksi video Shopee
 * ---------------------------------------------------------
 * Endpoint ini yang dipanggil oleh template Blogger (variabel
 * SHOPEE_API_ENDPOINT di <script> tema). Blogger sendiri tidak bisa
 * menjalankan proses ini (statis, tanpa server), makanya perlu
 * dihosting terpisah (lihat README.md untuk cara deploy).
 *
 * Cara kerja (bukan menebak struktur API internal Shopee — tapi
 * membuka halaman video Shopee memakai browser headless sungguhan,
 * lalu "menguping" file video (.mp4 / .m3u8) yang benar-benar
 * dimuat oleh halaman tersebut. Pendekatan ini lebih tahan
 * terhadap perubahan struktur internal Shopee dibanding menebak
 * endpoint API secara manual):
 *
 *   GET /api/shopee-extract?url=<link_video_shopee>
 *     -> buka link pakai Playwright (Chromium headless)
 *     -> tunggu & tangkap response yang content-type-nya video/*
 *        atau url-nya berakhiran .mp4 / .m3u8
 *     -> balikan JSON { title, duration, size, downloadUrl }
 *        (downloadUrl mengarah balik ke endpoint /api/download
 *        di server ini sendiri, BUKAN langsung ke CDN Shopee —
 *        supaya browser pengguna benar-benar mengunduh file,
 *        bukan cuma membuka video di tab baru)
 *
 *   GET /api/download?src=<url_video_asli_terenkode>
 *     -> stream ulang file video dari src ke browser pengguna
 *        dengan header Content-Disposition: attachment supaya
 *        memicu dialog "Save As" / unduhan otomatis.
 *
 * PENTING — baca README.md sebelum deploy:
 *  - Pendekatan ini butuh diverifikasi & mungkin disesuaikan
 *    sendiri dengan membuka DevTools (F12 > Network) di halaman
 *    video Shopee, karena struktur halaman Shopee bisa berubah
 *    sewaktu-waktu dan saya tidak punya cara memverifikasi
 *    endpoint internal Shopee dari sini.
 *  - Kalau video Shopee ternyata memakai format HLS (.m3u8,
 *    streaming per-segmen, bukan satu file .mp4 utuh), endpoint
 *    /api/download di bawah ini BELUM otomatis menggabungkannya
 *    jadi satu file — perlu tambahan proses remux pakai ffmpeg
 *    (lihat catatan TODO di bagian bawah file ini).
 */

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors()); // izinkan dipanggil dari domain Blogger kamu (fetch dari browser)

const PORT = process.env.PORT || 3000;
// Ganti dengan URL publik server ini setelah di-deploy (dipakai untuk
// menyusun link /api/download yang dikembalikan ke frontend).
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

const VIDEO_EXT_RE = /\.(mp4|m3u8)(\?|$)/i;
const SHOPEE_HOST_RE = /shopee\.(co\.id|com|com\.my|com\.br|ph|vn|sg|tw)$|shp\.ee$/i;

function isShopeeUrl(raw) {
  try {
    const u = new URL(raw);
    return SHOPEE_HOST_RE.test(u.hostname);
  } catch (e) {
    return false;
  }
}

// Satu browser instance dipakai ulang supaya lebih cepat & hemat memori
// dibanding buka-tutup browser baru setiap request.
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return browserPromise;
}

app.get('/api/shopee-extract', async (req, res) => {
  const shopeeUrl = req.query.url;

  if (!shopeeUrl || !isShopeeUrl(shopeeUrl)) {
    return res.status(400).json({ error: 'Parameter "url" kosong atau bukan link Shopee yang valid.' });
  }

  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
      viewport: { width: 414, height: 896 },
    });
    const page = await context.newPage();

    // Promise yang selesai begitu ada response berupa file video.
    const videoResponsePromise = new Promise((resolve) => {
      page.on('response', (response) => {
        const url = response.url();
        const contentType = response.headers()['content-type'] || '';
        if (contentType.startsWith('video/') || VIDEO_EXT_RE.test(url)) {
          resolve({ url, contentType, sizeHeader: response.headers()['content-length'] });
        }
      });
    });

    await page.goto(shopeeUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Sejumlah halaman video baru memuat file videonya setelah video
    // di-tap/di-play. Best effort: coba mainkan elemen <video> pertama
    // yang ditemukan, dan coba klik elemen umum bertipe tombol play.
    // SESUAIKAN selector ini kalau perlu, berdasarkan hasil inspeksi
    // DevTools kamu sendiri di halaman video Shopee yang sebenarnya.
    await page
      .evaluate(() => {
        const v = document.querySelector('video');
        if (v) { v.muted = true; v.play().catch(() => {}); }
      })
      .catch(() => {});
    await page.click('video, [class*="play"], [aria-label*="play" i]', { timeout: 3000 }).catch(() => {});

    const found = await Promise.race([
      videoResponsePromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 12000)),
    ]);

    // Ambil judul dari meta og:title / <title>, sebagai fallback pakai domain.
    const title = await page
      .evaluate(() => {
        const og = document.querySelector('meta[property="og:title"]');
        return (og && og.content) || document.title || 'Video Shopee';
      })
      .catch(() => 'Video Shopee');

    // Coba baca durasi video kalau elemen <video> tersedia di halaman.
    const duration = await page
      .evaluate(() => {
        const v = document.querySelector('video');
        if (!v || !isFinite(v.duration)) return null;
        const s = Math.round(v.duration);
        return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      })
      .catch(() => null);

    await context.close();

    if (!found) {
      return res.status(404).json({
        error:
          'Tidak menemukan file video di halaman ini dalam batas waktu. Coba lagi, atau sesuaikan server.js (lihat komentar di bagian "best effort").',
      });
    }

    const sizeLabel = found.sizeHeader
      ? `${(Number(found.sizeHeader) / (1024 * 1024)).toFixed(1)} MB`
      : null;

    return res.json({
      title,
      duration: duration || null,
      size: sizeLabel,
      // Diarahkan ke endpoint /api/download di server ini sendiri, BUKAN
      // langsung ke found.url — supaya browser pengguna benar-benar
      // mengunduh filenya (lihat komentar di endpoint /api/download).
      downloadUrl: `${PUBLIC_BASE_URL}/api/download?src=${encodeURIComponent(found.url)}`,
    });
  } catch (err) {
    if (context) { await context.close().catch(() => {}); }
    console.error(err);
    return res.status(500).json({ error: 'Gagal memproses link: ' + err.message });
  }
});

app.get('/api/download', async (req, res) => {
  const src = req.query.src;
  if (!src) { return res.status(400).json({ error: 'Parameter "src" kosong.' }); }

  // Batasi hanya boleh men-download dari host yang berbau Shopee/CDN-nya,
  // supaya endpoint ini tidak disalahgunakan jadi open proxy sembarang URL.
  let parsed;
  try { parsed = new URL(src); } catch (e) { return res.status(400).json({ error: 'src tidak valid.' }); }
  if (!/shopee|susercontent|sgp1\.cdn|akamaized/i.test(parsed.hostname)) {
    return res.status(400).json({ error: 'Host src tidak diizinkan.' });
  }

  try {
    const upstream = await fetch(src);
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: 'Gagal mengambil video dari sumber asli.' });
    }
    res.setHeader('Content-Disposition', 'attachment; filename="shopee-video.mp4"');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    const len = upstream.headers.get('content-length');
    if (len) { res.setHeader('Content-Length', len); }

    // Stream body upstream (Web ReadableStream) langsung ke response Express.
    const reader = upstream.body.getReader();
    req.on('close', () => reader.cancel().catch(() => {}));
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) { res.status(500).json({ error: 'Gagal streaming video: ' + err.message }); }
  }
});

app.get('/', (_req, res) => {
  res.json({ ok: true, message: 'ShopeeGrab API jalan. Lihat README.md untuk cara pakai.' });
});

app.listen(PORT, () => {
  console.log(`ShopeeGrab API listening on port ${PORT}`);
});

/* TODO (opsional, lanjutan):
 * - Kalau found.url berakhiran .m3u8 (bukan .mp4), itu format HLS
 *   (streaming per-segmen). Endpoint /api/download di atas akan
 *   mengunduh file .m3u8 mentah (playlist teks), BUKAN video utuh.
 *   Untuk menggabungkannya jadi satu .mp4, perlu proses tambahan
 *   pakai ffmpeg, misalnya:
 *     ffmpeg -i "<url.m3u8>" -c copy output.mp4
 *   dan menjalankannya via child_process dari endpoint /api/download,
 *   lalu stream hasil output.mp4-nya. Ini butuh ffmpeg terpasang di
 *   server (image Docker yang disarankan di README sudah cukup untuk
 *   Playwright, tapi belum tentu sudah ada ffmpeg — cek & tambahkan
 *   kalau ternyata video Shopee yang kamu uji memang format .m3u8).
 */
