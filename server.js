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
 *     -> tunggu & tangkap video yang benar-benar dimuat oleh pemutar
 *        Shopee di halaman (content-type video/* atau url .mp4/.m3u8),
 *        DALAM URUTAN KEMUNCULAN ASLINYA (bukan diurutkan ukuran file —
 *        lihat catatan "Kenapa video watermark bisa muncul" di bawah).
 *     -> SEKALIGUS, best-effort: scan body JSON dari setiap response
 *        API yang lewat selama halaman dimuat, cari string URL video
 *        yang tersimpan di field bernama semacam "source"/"original"/
 *        "nowatermark" dsb — beberapa platform video menyimpan link
 *        video "bersih" di data API-nya sendiri, terpisah dari file
 *        yang benar-benar diputar pemutar di halaman publik (yang
 *        watermark-nya kadang sudah dibakar langsung ke video untuk
 *        versi share/publik). Kandidat ini SPEKULATIF — server tidak
 *        bisa memastikan field itu memang ada / memang bersih, ini
 *        cuma percobaan tambahan, ditandai qualities[i].hint === 'nowm'
 *        supaya frontend memberi label "Coba Tanpa Watermark".
 *     -> balikan JSON { title, duration, qualities: [...] }, setiap
 *        item qualities berisi { size, downloadUrl, streamUrl, hint }.
 *        Kandidat dari JSON (kalau ada) ditaruh paling depan, disusul
 *        video yang disadap dari jaringan dalam urutan kemunculan asli.
 *
 * KENAPA VIDEO/HASIL DOWNLOAD BISA MASIH ADA WATERMARK SHOPEE:
 *   Kalau setelah update ini watermark MASIH muncul di preview maupun
 *   file yang terunduh, itu artinya file video yang dimuat pemutar
 *   Shopee di halaman publik memang SUDAH dibakar watermark-nya di
 *   sisi Shopee sendiri (bukan overlay CSS yang bisa dihilangkan lewat
 *   kode di sini) — persis video yang sama yang dilihat siapa pun yang
 *   membuka link itu langsung di browser biasa. Untuk kasus begini,
 *   satu-satunya jalan adalah menemukan sumber video "bersih" yang
 *   sesungguhnya (kalau memang ada) lewat inspeksi manual: buka link
 *   Shopee itu di Chrome desktop, F12 > tab Network > filter "Fetch/XHR"
 *   (BUKAN "Media"), putar videonya, lalu cari response JSON yang berisi
 *   data video (biasanya nama field mengandung kata "video"/"play"/
 *   "media") dan periksa apakah ada URL video LAIN di situ selain yang
 *   dipakai pemutar. Kalau ketemu, kirim ke saya nama field & contoh
 *   response-nya (redact info sensitif) supaya scoring di
 *   walkForVideoUrls() bisa disesuaikan supaya field itu diprioritaskan.
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

// --- Scan JSON API responses untuk kandidat URL video "bersih" ---------
// Lihat catatan panjang di komentar atas file ini ("KENAPA VIDEO/HASIL
// DOWNLOAD BISA MASIH ADA WATERMARK"). Ini murni best-effort/heuristik.
const KEY_HINT_SCORES = [
  { re: /no.?watermark|nowm|clean|original|source|raw/i, score: 3 },
  { re: /download/i, score: 2 },
  { re: /video.?url|play.?url|play.?addr|media.?url|^\.src$|\.src$/i, score: 1 },
];

function scoreKeyPath(path) {
  let best = 0;
  for (const hint of KEY_HINT_SCORES) {
    if (hint.re.test(path) && hint.score > best) best = hint.score;
  }
  // Field yang eksplisit menyebut "watermark" tanpa kata "no" di
  // depannya kemungkinan justru versi BER-watermark — turunkan skornya
  // supaya tidak dipilih duluan.
  if (/watermark/i.test(path) && !/no.?watermark/i.test(path)) best -= 5;
  return best;
}

function walkForVideoUrls(node, pathPrefix, out, depth) {
  if (depth > 6 || node == null) return;
  if (typeof node === 'string') {
    if (VIDEO_EXT_RE.test(node) && /^https?:\/\//i.test(node)) {
      out.push({ url: node, score: scoreKeyPath(pathPrefix) });
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkForVideoUrls(item, `${pathPrefix}[${i}]`, out, depth + 1));
    return;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node)) {
      walkForVideoUrls(node[key], `${pathPrefix}.${key}`, out, depth + 1);
    }
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

    // Kumpulkan SEMUA response berupa file video selama halaman dimuat
    // (bukan cuma yang pertama ketemu), TETAP dalam urutan kemunculan
    // aslinya — tidak diurutkan ulang berdasarkan ukuran file di sini,
    // karena video besar yang lain (mis. video "lainnya buat kamu" yang
    // ikut ter-autoplay di halaman) bisa saja bukan video yang diminta
    // dan malah lebih besar ukurannya. Video pertama yang ditemukan
    // untuk link yang diminta adalah kandidat paling dipercaya.
    const foundVideos = [];
    const seenUrls = new Set();
    // Sekaligus, kumpulkan kandidat URL video "bersih" dari body JSON
    // API yang lewat (lihat walkForVideoUrls & catatan panjang di atas).
    const jsonCandidates = [];
    const seenJsonUrls = new Set();
    const pendingJsonParses = [];

    page.on('response', (response) => {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';

      if ((contentType.startsWith('video/') || VIDEO_EXT_RE.test(url)) && !seenUrls.has(url)) {
        seenUrls.add(url);
        foundVideos.push({ url, contentType, sizeHeader: response.headers()['content-length'] });
        return;
      }

      if (contentType.includes('application/json')) {
        const parsePromise = response
          .json()
          .then((body) => {
            const out = [];
            walkForVideoUrls(body, '', out, 0);
            for (const c of out) {
              if (!seenJsonUrls.has(c.url)) {
                seenJsonUrls.add(c.url);
                jsonCandidates.push(c);
              }
            }
          })
          .catch(() => {}); // body bukan JSON valid / response sudah tertutup — abaikan
        pendingJsonParses.push(parsePromise);
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

    // Tunggu sampai 20 detik, sambil terus mengumpulkan video yang
    // ketemu (lihat page.on('response', ...) di atas) — TIDAK berhenti
    // begitu video pertama ketemu, supaya varian kualitas lain (kalau
    // ada) juga sempat tertangkap. Kalau video pertama sudah ketemu
    // lebih awal, tetap tunggu maksimal 4 detik tambahan saja (bukan
    // full 20 detik) supaya responsnya tidak terasa lambat.
    const deadline = Date.now() + 20000;
    let extraWaitAfterFirst = null;
    while (Date.now() < deadline) {
      if (foundVideos.length > 0) {
        if (extraWaitAfterFirst === null) { extraWaitAfterFirst = Date.now() + 4000; }
        if (Date.now() > extraWaitAfterFirst) { break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    // Body JSON response bisa masih diparse async setelah polling di atas
    // selesai — beri jeda singkat (maks 3 detik) supaya jsonCandidates
    // sempat terisi sebelum kita susun hasil akhirnya.
    await Promise.race([
      Promise.allSettled(pendingJsonParses),
      new Promise((resolve) => setTimeout(resolve, 3000)),
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

    if (foundVideos.length === 0 && jsonCandidates.length === 0) {
      return res.status(404).json({
        error:
          'Tidak menemukan file video di halaman ini dalam batas waktu. Coba lagi, atau sesuaikan server.js (lihat komentar di bagian "best effort").',
      });
    }

    // Susun daftar akhir: kandidat dari JSON (kalau skornya positif —
    // artinya nama field-nya cocok pola "kemungkinan bersih") ditaruh
    // PALING DEPAN sebagai percobaan, disusul video yang benar-benar
    // disadap dari jaringan DALAM URUTAN KEMUNCULAN ASLI (bukan diurutkan
    // ukuran — lihat catatan panjang di komentar atas file ini soal
    // kenapa itu bisa memilih video yang salah/ber-watermark). Maksimal
    // 2 kandidat JSON diambil supaya daftar kualitas tidak kebanjiran
    // entri spekulatif.
    jsonCandidates.sort((a, b) => b.score - a.score);
    const topJsonCandidates = jsonCandidates.filter((c) => c.score > 0).slice(0, 2);

    const addedUrls = new Set();
    const qualities = [];

    for (const c of topJsonCandidates) {
      if (addedUrls.has(c.url)) continue;
      addedUrls.add(c.url);
      qualities.push({
        size: null,
        hint: 'nowm', // frontend memberi label "Coba Tanpa Watermark" untuk ini
        downloadUrl: `${PUBLIC_BASE_URL}/api/download?src=${encodeURIComponent(c.url)}`,
        streamUrl: `${PUBLIC_BASE_URL}/api/stream?src=${encodeURIComponent(c.url)}`,
      });
    }

    for (const v of foundVideos) {
      if (addedUrls.has(v.url)) continue;
      addedUrls.add(v.url);
      qualities.push({
        size: v.sizeHeader ? `${(Number(v.sizeHeader) / (1024 * 1024)).toFixed(1)} MB` : null,
        hint: null,
        // downloadUrl: dipakai tombol "Simpan Video" (memaksa unduhan).
        downloadUrl: `${PUBLIC_BASE_URL}/api/download?src=${encodeURIComponent(v.url)}`,
        // streamUrl: dipakai elemen <video> pratinjau (main inline, bukan unduh).
        streamUrl: `${PUBLIC_BASE_URL}/api/stream?src=${encodeURIComponent(v.url)}`,
      });
    }

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
