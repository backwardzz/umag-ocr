/**
 * Прогон фото через тот же конвейер, что и в браузере, но в Node.
 *   npm run ocr -- samples/1.jpg [--psm 6] [--text]
 * Сохраняет предобработанное изображение в out/ и OCR-результат в samples/*.ocr.json
 * (его потом используют тесты парсеров, чтобы не гонять OCR каждый раз).
 */
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { createWorker, PSM } from 'tesseract.js';
import { preprocess, grayToRGBA, rotate90, type Gray } from '../src/core/image';
import { toOcrPage } from '../src/core/ocrTypes';
import { recognizePage, type Recognizer } from '../src/core/pipeline';
import { printDoc } from './print';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const psmIdx = args.indexOf('--psm');
const psm = psmIdx >= 0 ? args[psmIdx + 1] : '6';

/** Ориентация из EXIF (1 — как есть, 6 — повернуть на 90° по часовой, и т. д.); браузер применяет её сам, jpeg-js — нет */
function exifOrientation(b: Buffer): number {
  let o = 2;
  while (o + 4 < b.length && b[o] === 0xff) {
    const marker = b[o + 1];
    const len = b.readUInt16BE(o + 2);
    if (marker === 0xe1 && b.toString('latin1', o + 4, o + 8) === 'Exif') {
      const t = o + 10;
      const le = b.toString('latin1', t, t + 2) === 'II';
      const r16 = (p: number) => (le ? b.readUInt16LE(p) : b.readUInt16BE(p));
      const r32 = (p: number) => (le ? b.readUInt32LE(p) : b.readUInt32BE(p));
      const ifd = t + r32(t + 4);
      for (let i = 0, n = r16(ifd); i < n; i++) if (r16(ifd + 2 + i * 12) === 0x0112) return r16(ifd + 2 + i * 12 + 8);
      return 1;
    }
    if (marker >= 0xc0 && marker <= 0xc2) break; // дальше только изображение
    o += 2 + len;
  }
  return 1;
}

/** Поворот/отражение пикселей по значению EXIF Orientation (1–8) */
function orient(img: { data: Uint8Array; width: number; height: number }, ori: number) {
  if (ori === 1) return img;
  const { data, width: w, height: h } = img;
  const swap = ori >= 5;
  const nw = swap ? h : w;
  const nh = swap ? w : h;
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number, ny: number;
      switch (ori) {
        case 2: nx = w - 1 - x; ny = y; break;
        case 3: nx = w - 1 - x; ny = h - 1 - y; break;
        case 4: nx = x; ny = h - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = h - 1 - y; ny = x; break;
        case 7: nx = h - 1 - y; ny = w - 1 - x; break;
        default: nx = y; ny = w - 1 - x; break; // 8
      }
      const s = (y * w + x) * 4;
      const d = (ny * nw + nx) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { data: out, width: nw, height: nh };
}

function decode(file: string) {
  const buf = fs.readFileSync(file);
  if (/\.png$/i.test(file)) {
    const png = PNG.sync.read(buf);
    return { data: png.data, width: png.width, height: png.height };
  }
  const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
  return orient(img, exifOrientation(buf));
}

const toPng = (g: Gray) => {
  const png = new PNG({ width: g.w, height: g.h });
  png.data = Buffer.from(grayToRGBA(g));
  return PNG.sync.write(png);
};

fs.mkdirSync('out', { recursive: true });
const worker = await createWorker(['rus', 'eng'], 1, { langPath: path.resolve('public/tesseract/lang'), cachePath: path.resolve('out/.tess-cache') });
await worker.setParameters({
  tessedit_pageseg_mode: psm as PSM,
  preserve_interword_spaces: '1',
  user_defined_dpi: '300',
});

const recognize: Recognizer = async (img, opts) => {
  await worker.setParameters({ tessedit_char_whitelist: opts.whitelist ?? '' });
  const { data } = await worker.recognize(toPng(img), {}, { text: true, blocks: true });
  return toOcrPage(data, img.w, img.h).lines;
};

for (const file of files) {
  const t0 = Date.now();
  const img = decode(file);
  const pre = preprocess(img.data, img.width, img.height);
  const t1 = Date.now();
  const base = path.basename(file).replace(/\.\w+$/, '');
  fs.writeFileSync(path.join('out', `${base}.pre.png`), toPng(pre.image));
  const { page, doc, image } = await recognizePage(pre.image, { rules: pre.rules, charHeight: pre.charHeight * pre.scale }, recognize, undefined, async (cw) => {
    const r = rotate90(img.data, img.width, img.height, cw);
    const p = preprocess(r.data, r.width, r.height);
    return { image: p.image, extra: { rules: p.rules, charHeight: p.charHeight * p.scale } };
  });
  if (image !== pre.image) fs.writeFileSync(path.join('out', `${base}.pre.png`), toPng(image));
  const t2 = Date.now();
  fs.writeFileSync(file.replace(/\.\w+$/, '.ocr.json'), JSON.stringify(page, null, 1));
  console.log(`===== ${file}: pre ${t1 - t0}ms (char ${pre.charHeight}px, scale ${pre.scale.toFixed(2)}), ocr ${t2 - t1}ms, strips ${page.strips?.length ?? 0}`);
  if (args.includes('--text')) console.log(page.lines.map((l) => l.text).join('\n'));
  printDoc(doc);
}
await worker.terminate();
