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
 *     -> tunggu video PERTAMA yang benar-benar dimuat oleh pemutar
 *        Shopee di halaman (content-type video/* atau url .mp4/.m3u8),
 *        lalu berhenti menunggu SEGERA setelah itu (dengan jeda sangat
 *        singkat untuk menangkap varian kualitas lain kalau kebetulan
 *        datang hampir bersamaan) — supaya responsnya cepat.
 *     -> balikan JSON { title, duration, qualities: [...] }, item
 *        PERTAMA di array `qualities` selalu video pertama yang
 *        ditemukan (persis logika versi awal yang sudah terbukti
 *        menghasilkan file TANPA watermark di test kamu sebelumnya).
 *
 * RIWAYAT PENTING soal watermark (baca ini kalau nanti perlu debug
 * ulang): sempat ada 1 ronde percobaan yang menambahkan "pemindaian
 * JSON" untuk MENEBAK sumber video "bersih" tambahan (dari response API
 * & dari data yang ditanam di HTML halaman). Fitur itu SUDAH DIHAPUS
 * dari file ini karena terbukti jadi PENYEBAB watermark muncul: heuristik
 * penebakannya kadang salah menangkap URL video LAIN (bukan video yang
 * diminta pengguna) dan menaruhnya di urutan pertama, menggantikan video
 * yang sebenarnya sudah benar. Pelajarannya: JANGAN tambahkan lagi teknik
 * "menebak" sumber video tanpa cara memverifikasinya — attributi
 * `downloadUrl`/`streamUrl` di sini SELALU berasal dari video yang
 * benar-benar disadap dari jaringan saat pemutar Shopee memuat video
 * yang diminta, tidak ada tebakan lain.
 *
 *   GET /api/download?src=<url_video_asli_terenkode>
 *     -> stream ulang file video dari src ke browser pengguna
 *        dengan header Content-Disposition: attachment supaya
 *        memicu dialog "Save As" / unduhan otomatis. Dipakai oleh
 *        tombol "Simpan Video Tanpa Watermark" di frontend.
 *
 *   GET /api/stream?src=<url_video_asli_terenkode>
 *     -> sama seperti /api/download, tapi TANPA header attachment
 *        (dan mendukung Range request untuk seek/scrubbing), supaya
 *        videonya bisa diputar langsung di elemen <video> pratinjau
 *        pada halaman, bukan otomatis ke-download.
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

    // Kumpulkan video yang benar-benar dimuat pemutar Shopee di halaman,
    // DALAM URUTAN KEMUNCULAN ASLI. Item PERTAMA di array ini adalah
    // video yang dipakai sebagai hasil utama (downloadUrl/streamUrl
    // default) — persis logika versi awal yang sudah terbukti bersih
    // dari watermark. Video tambahan (kalau ada varian kualitas lain
    // yang datang hampir bersamaan) tetap ditangkap untuk daftar
    // "Available Qualities", tapi TIDAK PERNAH menggantikan urutan
    // video pertama sebagai default.
    const foundVideos = [];
    const seenUrls = new Set();

    page.on('response', (response) => {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';
      if ((contentType.startsWith('video/') || VIDEO_EXT_RE.test(url)) && !seenUrls.has(url)) {
        seenUrls.add(url);
        foundVideos.push({ url, contentType, sizeHeader: response.headers()['content-length'] });
      }
    });

    // 'commit' jauh lebih longgar daripada 'domcontentloaded': cukup
    // menunggu navigasi mulai diterima server tujuan, tidak menunggu
    // SEMUA resource halaman (termasuk tracker/analytics pihak ketiga
    // yang kadang bikin 'domcontentloaded' macet/timeout di halaman
    // berat seperti Shopee). Timeout juga diperpanjang jadi 45 detik.
    await page.goto(shopeeUrl, { waitUntil: 'commit', timeout: 45000 });
    // Beri sedikit waktu tambahan supaya halaman & videonya sempat
    // benar-benar termuat di background sebelum lanjut ke langkah
    // berikutnya (tidak mem-block keras seperti 'domcontentloaded').
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});

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

    // Tunggu video pertama muncul (maks 15 detik untuk halaman yang
    // lambat), lalu berhenti SEGERA dengan jeda singkat (900ms) untuk
    // menangkap varian kualitas lain kalau kebetulan datang hampir
    // bersamaan. Ini jauh lebih cepat dari versi sebelumnya (yang bisa
    // menunggu sampai ~24 detik) — supaya responsnya terasa instan
    // seperti situs pembanding, tanpa mengorbankan video pertama yang
    // memang dipakai sebagai hasil utama.
    const deadline = Date.now() + 15000;
    let extraWaitAfterFirst = null;
    while (Date.now() < deadline) {
      if (foundVideos.length > 0) {
        if (extraWaitAfterFirst === null) { extraWaitAfterFirst = Date.now() + 900; }
        if (Date.now() > extraWaitAfterFirst) { break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

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

    if (foundVideos.length === 0) {
      return res.status(404).json({
        error:
          'Tidak menemukan file video di halaman ini dalam batas waktu. Coba lagi, atau sesuaikan server.js (lihat komentar di bagian "best effort").',
      });
    }

    // qualities[0] = video PERTAMA yang ditemukan (lihat catatan panjang
    // di atas file ini). Video lain (kalau ada, ditemukan hampir
    // bersamaan) disusul di belakang, tetap dalam urutan kemunculan asli
    // — TIDAK diurutkan ulang berdasarkan ukuran file, supaya tidak ada
    // risiko video lain menggantikan video pertama sebagai default.
    const qualities = foundVideos.map((v) => ({
      size: v.sizeHeader ? `${(Number(v.sizeHeader) / (1024 * 1024)).toFixed(1)} MB` : null,
      // downloadUrl: dipakai tombol "Simpan Video" (memaksa unduhan).
      downloadUrl: `${PUBLIC_BASE_URL}/api/download?src=${encodeURIComponent(v.url)}`,
      // streamUrl: dipakai elemen <video> pratinjau (main inline, bukan unduh).
      streamUrl: `${PUBLIC_BASE_URL}/api/stream?src=${encodeURIComponent(v.url)}`,
    }));

    return res.json({
      title,
      duration: duration || null,
      qualities,
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

app.get('/api/stream', async (req, res) => {
  const src = req.query.src;
  if (!src) { return res.status(400).json({ error: 'Parameter "src" kosong.' }); }

  let parsed;
  try { parsed = new URL(src); } catch (e) { return res.status(400).json({ error: 'src tidak valid.' }); }
  if (!/shopee|susercontent|sgp1\.cdn|akamaized/i.test(parsed.hostname)) {
    return res.status(400).json({ error: 'Host src tidak diizinkan.' });
  }

  try {
    // Teruskan header Range dari browser (dipakai <video> untuk seek /
    // scrubbing) ke request upstream, supaya upstream juga membalas
    // sebagian file saja (206 Partial Content) alih-alih seluruh file.
    const upstreamHeaders = {};
    if (req.headers.range) { upstreamHeaders['Range'] = req.headers.range; }

    const upstream = await fetch(src, { headers: upstreamHeaders });
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: 'Gagal mengambil video dari sumber asli.' });
    }

    res.status(upstream.status); // teruskan 200 atau 206 apa adanya
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    const len = upstream.headers.get('content-length');
    if (len) { res.setHeader('Content-Length', len); }
    const range = upstream.headers.get('content-range');
    if (range) { res.setHeader('Content-Range', range); }
    // SENGAJA tidak diberi header Content-Disposition di sini — supaya
    // browser memutar videonya langsung (inline), bukan men-download.

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
