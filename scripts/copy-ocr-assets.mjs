// Копирует движок Tesseract (worker + wasm) и языковые модели в public/tesseract,
// чтобы приложение работало без обращения к CDN (в т.ч. офлайн после первой загрузки).
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const out = path.join(root, 'public', 'tesseract');
const coreOut = path.join(out, 'core');
const langOut = path.join(out, 'lang');
fs.mkdirSync(coreOut, { recursive: true });
fs.mkdirSync(langOut, { recursive: true });

const nm = path.join(root, 'node_modules');
fs.copyFileSync(path.join(nm, 'tesseract.js', 'dist', 'worker.min.js'), path.join(out, 'worker.min.js'));
for (const f of fs.readdirSync(path.join(nm, 'tesseract.js-core'))) {
  if (/^tesseract-core.*\.(js|wasm)$/.test(f)) fs.copyFileSync(path.join(nm, 'tesseract.js-core', f), path.join(coreOut, f));
}

// Модели rus/eng (best_int) — те же, что tesseract.js берёт по умолчанию
const LANG_URL = (l) => `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${l}/4.0.0_best_int/${l}.traineddata.gz`;
function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(new URL(res.headers.location, url).toString(), dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}
for (const l of ['rus', 'eng']) {
  const dest = path.join(langOut, `${l}.traineddata.gz`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) continue;
  console.log(`Скачиваю языковую модель ${l}...`);
  await download(LANG_URL(l), dest);
}
console.log('OCR-ресурсы готовы: public/tesseract');

// pdf.js: кодировки и стандартные шрифты для PDF, в которые они не встроены
const pdfOut = path.join(root, 'public', 'pdfjs');
for (const dir of ['cmaps', 'standard_fonts']) {
  const src = path.join(nm, 'pdfjs-dist', dir);
  if (!fs.existsSync(src)) continue;
  fs.mkdirSync(path.join(pdfOut, dir), { recursive: true });
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(pdfOut, dir, f));
}
console.log('Ресурсы PDF готовы: public/pdfjs');
