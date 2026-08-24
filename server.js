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
 * WATERMARK SUDAH TERBUKTI DIBAKAR KE VIDEO (bukan lagi dugaan): dari
 * screenshot yang dikirim pengguna, video asli dari Shopee memang punya
 * DUA elemen watermark yang menyatu ke pixel videonya sendiri (bukan
 * overlay HTML/CSS yang bisa dihilangkan dari sisi kita begitu saja):
 *   1. Badge kecil "Shopee Video @<handle>" yang muncul terus-menerus di
 *      salah satu sisi video sepanjang durasi.
 *   2. Kartu penutup ("outro"/end-card) — layar penuh berlogo Shopee di
 *      beberapa detik terakhir video.
 * Karena itu, satu-satunya cara menghilangkannya adalah memproses ULANG
 * videonya (bukan lagi "mencari file lain"): mengaburkan area badge
 * dengan filter `delogo`, dan memotong (trim) bagian akhir video supaya
 * outro-nya tidak ikut terunduh. Ini dikerjakan oleh fungsi
 * getCleanVideoPath() di bawah, pakai ffmpeg (lihat juga Dockerfile —
 * ffmpeg ditambahkan ke image lewat apt-get).
 *
 * INI PERTUKARAN (TRADE-OFF) YANG PERLU DIPAHAMI: memproses video makan
 * waktu CPU nyata (encoding ulang), beda dengan sebelumnya yang cuma
 * meneruskan (proxy) byte video apa adanya secara instan. Di server
 * gratisan (Render free tier, CPU terbatas & dibagi-bagi), ini bisa
 * memperlambat /api/download dan /api/stream dari yang tadinya hampir
 * instan menjadi beberapa detik sampai puluhan detik tergantung panjang
 * video & beban server saat itu — TIDAK MUNGKIN sama cepatnya dengan
 * cuma proxy mentah. Hasil pemrosesan di-cache per video (lihat
 * CACHE_DIR) supaya permintaan KEDUA untuk video yang sama jadi instan
 * lagi, tapi permintaan PERTAMA untuk tiap video akan selalu kena biaya
 * waktu proses ini.
 *
 * Koordinat kotak badge (WATERMARK_BOX) & lama potongan outro
 * (OUTRO_TRIM_SECONDS) di bawah ini adalah ESTIMASI dari SATU contoh
 * screenshot video — belum tentu pas persis untuk semua video Shopee
 * (posisi/ukuran badge kemungkinan konsisten karena itu elemen UI
 * platform, tapi durasi outro bisa saja berbeda-beda). Kalau setelah
 * dites videonya masih kelihatan sisa watermark, atau malah kepotong
 * konten aslinya, sesuaikan angka-angka ini.
 *
 *   GET /api/download?src=<url_video_asli_terenkode>
 *     -> coba proses dulu videonya lewat getCleanVideoPath() (hapus
 *        watermark), lalu kirim hasilnya dengan header
 *        Content-Disposition: attachment supaya memicu unduhan
 *        otomatis. Kalau pemrosesan gagal/timeout, JATUH KEMBALI
 *        (fallback) ke stream mentah apa adanya (tetap ada watermark,
 *        tapi setidaknya user tidak mendapat error total).
 *
 *   GET /api/stream?src=<url_video_asli_terenkode>
 *     -> sama seperti /api/download (proses dulu, fallback kalau
 *        gagal), tapi TANPA header attachment (dan mendukung Range
 *        request untuk seek/scrubbing), supaya videonya bisa diputar
 *        langsung di elemen <video> pratinjau pada halaman.
 *
 * PENTING — baca README.md sebelum deploy:
 *  - Pendekatan ekstraksi video ini butuh diverifikasi & mungkin
 *    disesuaikan sendiri dengan membuka DevTools (F12 > Network) di
 *    halaman video Shopee, karena struktur halamannya bisa berubah
 *    sewaktu-waktu dan saya tidak punya cara memverifikasi endpoint
 *    internal Shopee dari sini.
 *  - Kalau video Shopee ternyata memakai format HLS (.m3u8, streaming
 *    per-segmen), ffmpeg di getCleanVideoPath() SUDAH otomatis
 *    menangani ini juga (ffmpeg bisa baca .m3u8 langsung sebagai
 *    input), jadi TODO lama soal m3u8 di bagian bawah file ini
 *    seharusnya sudah tidak relevan lagi untuk jalur /api/download
 *    yang berhasil diproses (hanya relevan kalau jalur fallback mentah
 *    yang terpakai).
 */

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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

// --- Penghapusan watermark Shopee (delogo badge + potong outro) --------
// Lihat catatan panjang di komentar atas file ini. ESTIMASI dari 1
// screenshot, mungkin perlu disesuaikan — lihat catatan di masing-masing
// konstanta.
//
// Posisi & ukuran badge "Shopee Video @handle", sebagai FRAKSI dari
// lebar/tinggi video (bukan pixel absolut, supaya otomatis menyesuaikan
// berapa pun resolusi video aslinya). Diukur dari screenshot: badge ada
// di kiri, kira-kira 40%-53% dari tinggi video, lebar sampai ~38% dari
// kiri. Sengaja diberi sedikit margin ekstra di semua sisi (dibanding
// angka mentah hasil ukur) supaya seluruh teksnya tertutup walau posisi
// meleset sedikit di video lain.
const WATERMARK_BOX = { xFrac: 0.0, yFrac: 0.40, wFrac: 0.42, hFrac: 0.14 };

// Lama potongan di akhir video (detik) untuk membuang kartu penutup
// ("outro") berlogo Shopee. Ini TEBAKAN AWAL — kalau video hasil unduhan
// masih menyisakan sedikit outro-nya, PERBESAR angka ini; kalau malah
// memotong bagian akhir konten asli (mis. video jadi terasa terpotong
// mendadak), PERKECIL angka ini.
const OUTRO_TRIM_SECONDS = 1.5;

// Batas waktu maksimum proses ffmpeg per video sebelum menyerah &
// jatuh kembali (fallback) ke video mentah apa adanya. Server gratisan
// bisa lambat, jadi diberi jeda cukup longgar (60 detik) — tapi tetap
// dibatasi supaya request tidak menggantung selamanya kalau ffmpeg
// macet.
const PROCESS_TIMEOUT_MS = 60000;

const CACHE_DIR = path.join(os.tmpdir(), 'shopeegrab-clean-cache');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { /* sudah ada / tidak masalah */ }

function cacheKeyFor(url) {
  return crypto.createHash('sha1').update(url).digest('hex');
}

// Jalankan sebuah command lewat child_process, kumpulkan stdout, dengan
// timeout paksa (kill process kalau kelamaan).
function runCommand(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`${cmd} timeout setelah ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) { resolve({ stdout, stderr }); }
      else { reject(new Error(`${cmd} keluar dengan kode ${code}: ${stderr.slice(-500)}`)); }
    });
  });
}

async function probeVideo(srcUrl) {
  const { stdout } = await runCommand(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json',
      srcUrl,
    ],
    20000,
  );
  const parsed = JSON.parse(stdout);
  const videoStream = (parsed.streams || []).find((s) => s.width && s.height) || {};
  const duration = parsed.format && parsed.format.duration ? Number(parsed.format.duration) : null;
  return {
    width: videoStream.width || null,
    height: videoStream.height || null,
    duration: Number.isFinite(duration) ? duration : null,
  };
}

// Cache: satu Promise per URL yang sedang diproses, supaya kalau ada 2
// request nyaris bersamaan untuk video yang sama (mis. preview & tombol
// download diklik hampir bareng), ffmpeg cuma jalan SEKALI, bukan dobel.
const processingPromises = new Map();

async function getCleanVideoPath(srcUrl) {
  const key = cacheKeyFor(srcUrl);
  const outPath = path.join(CACHE_DIR, `${key}.mp4`);

  if (fs.existsSync(outPath)) { return outPath; }
  if (processingPromises.has(key)) { return processingPromises.get(key); }

  const promise = (async () => {
    const info = await probeVideo(srcUrl);
    if (!info.width || !info.height) {
      throw new Error('Tidak bisa membaca info video (ffprobe gagal / video tidak valid).');
    }

    const x = Math.max(0, Math.round(WATERMARK_BOX.xFrac * info.width));
    const y = Math.max(0, Math.round(WATERMARK_BOX.yFrac * info.height));
    const w = Math.min(info.width - x, Math.round(WATERMARK_BOX.wFrac * info.width));
    const h = Math.min(info.height - y, Math.round(WATERMARK_BOX.hFrac * info.height));

    const args = ['-y', '-i', srcUrl];
    if (info.duration && info.duration > OUTRO_TRIM_SECONDS + 1) {
      args.push('-t', String((info.duration - OUTRO_TRIM_SECONDS).toFixed(2)));
    }
    // Tulis ke file sementara dulu, baru rename ke nama final SETELAH
    // ffmpeg selesai sukses — supaya request lain yang mengecek
    // fs.existsSync(outPath) tidak pernah membaca file yang masih
    // setengah jadi.
    const tmpOutPath = `${outPath}.partial.mp4`;
    args.push(
      '-vf', `delogo=x=${x}:y=${y}:w=${w}:h=${h}:show=0`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      tmpOutPath,
    );

    try {
      await runCommand('ffmpeg', args, PROCESS_TIMEOUT_MS);
      fs.renameSync(tmpOutPath, outPath);
    } catch (err) {
      try { fs.unlinkSync(tmpOutPath); } catch (e) { /* abaikan */ }
      throw err;
    }
    return outPath;
  })();

  processingPromises.set(key, promise);
  promise.finally(() => processingPromises.delete(key));
  return promise;
}

// Bersih-bersih cache lama secara oportunistik (dipanggil sesekali, tidak
// mem-block request) supaya disk sementara server tidak penuh.
function cleanupOldCache(maxAgeMs) {
  fs.readdir(CACHE_DIR, (err, files) => {
    if (err || !files) return;
    const now = Date.now();
    files.forEach((f) => {
      const p = path.join(CACHE_DIR, f);
      fs.stat(p, (statErr, stat) => {
        if (statErr) return;
        if (now - stat.mtimeMs > maxAgeMs) { fs.unlink(p, () => {}); }
      });
    });
  });
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

  // Fire-and-forget, tidak menunda response — bersih-bersih file cache
  // video yang sudah diproses lebih dari 1 jam supaya disk sementara
  // server tidak terus penuh.
  cleanupOldCache(60 * 60 * 1000);

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

// Validasi host src (dipakai bareng oleh /api/download & /api/stream).
function isAllowedSrcHost(src) {
  try {
    const parsed = new URL(src);
    return /shopee|susercontent|sgp1\.cdn|akamaized/i.test(parsed.hostname);
  } catch (e) {
    return false;
  }
}

// Fallback: proxy video APA ADANYA (tanpa proses hapus watermark) —
// dipakai kalau getCleanVideoPath() gagal/timeout, supaya pengguna
// setidaknya tetap dapat videonya (dengan watermark) alih-alih error
// total. asAttachment=true memicu unduhan otomatis (dipakai
// /api/download); false untuk diputar inline (dipakai /api/stream).
async function streamRaw(req, res, src, asAttachment) {
  const upstreamHeaders = {};
  if (!asAttachment && req.headers.range) { upstreamHeaders['Range'] = req.headers.range; }

  const upstream = await fetch(src, { headers: upstreamHeaders });
  if (!upstream.ok || !upstream.body) {
    throw new Error('Gagal mengambil video dari sumber asli.');
  }

  res.status(upstream.status);
  if (asAttachment) { res.setHeader('Content-Disposition', 'attachment; filename="shopee-video.mp4"'); }
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  const len = upstream.headers.get('content-length');
  if (len) { res.setHeader('Content-Length', len); }
  const range = upstream.headers.get('content-range');
  if (range) { res.setHeader('Content-Range', range); }

  const reader = upstream.body.getReader();
  req.on('close', () => reader.cancel().catch(() => {}));
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

app.get('/api/download', async (req, res) => {
  const src = req.query.src;
  if (!src) { return res.status(400).json({ error: 'Parameter "src" kosong.' }); }
  if (!isAllowedSrcHost(src)) { return res.status(400).json({ error: 'Host src tidak diizinkan.' }); }

  try {
    // Coba proses dulu (hapus watermark) — lihat catatan panjang di atas
    // file ini soal trade-off kecepatan.
    const cleanPath = await getCleanVideoPath(src);
    return res.sendFile(cleanPath, {
      headers: {
        'Content-Disposition': 'attachment; filename="shopee-video.mp4"',
        'Content-Type': 'video/mp4',
      },
    });
  } catch (err) {
    console.error('getCleanVideoPath gagal, fallback ke video mentah (masih ada watermark):', err.message);
    try {
      await streamRaw(req, res, src, true);
    } catch (fallbackErr) {
      console.error(fallbackErr);
      if (!res.headersSent) { res.status(500).json({ error: 'Gagal streaming video: ' + fallbackErr.message }); }
    }
  }
});

app.get('/api/stream', async (req, res) => {
  const src = req.query.src;
  if (!src) { return res.status(400).json({ error: 'Parameter "src" kosong.' }); }
  if (!isAllowedSrcHost(src)) { return res.status(400).json({ error: 'Host src tidak diizinkan.' }); }

  try {
    const cleanPath = await getCleanVideoPath(src);
    // res.sendFile menangani header Range secara otomatis (dipakai
    // <video> untuk seek/scrubbing) — tidak perlu ditulis manual lagi
    // seperti versi proxy mentah sebelumnya.
    return res.sendFile(cleanPath, { headers: { 'Content-Type': 'video/mp4' } });
  } catch (err) {
    console.error('getCleanVideoPath gagal, fallback ke video mentah (masih ada watermark):', err.message);
    try {
      await streamRaw(req, res, src, false);
    } catch (fallbackErr) {
      console.error(fallbackErr);
      if (!res.headersSent) { res.status(500).json({ error: 'Gagal streaming video: ' + fallbackErr.message }); }
    }
  }
});

app.get('/', (_req, res) => {
  res.json({ ok: true, message: 'ShopeeGrab API jalan. Lihat README.md untuk cara pakai.' });
});

app.listen(PORT, () => {
  console.log(`ShopeeGrab API listening on port ${PORT}`);
});

/* TODO (opsional, lanjutan):
 * - Kasus .m3u8 (HLS) sekarang otomatis tertangani oleh ffmpeg di
 *   getCleanVideoPath() selama jalur /api/download & /api/stream
 *   berhasil diproses (ffmpeg bisa baca .m3u8 langsung sebagai input,
 *   hasil outputnya tetap .mp4 utuh). Ini cuma jadi masalah lagi kalau
 *   jalur fallback mentah (streamRaw) yang terpakai — itu murni proxy
 *   byte apa adanya, jadi kalau src-nya .m3u8, hasilnya cuma file
 *   playlist teks, bukan video utuh.
 * - Kalau di kemudian hari koordinat WATERMARK_BOX / OUTRO_TRIM_SECONDS
 *   di atas file ini perlu disesuaikan (badge kepotong tidak pas, atau
 *   outro masih tersisa/konten asli malah terpotong), user perlu kirim
 *   contoh screenshot video terbaru supaya angkanya bisa diukur ulang.
 */
