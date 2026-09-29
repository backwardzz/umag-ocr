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
import { preprocess, grayToRGBA, type Gray } from '../src/core/image';
import { toOcrPage } from '../src/core/ocrTypes';
import { recognizePage, type Recognizer } from '../src/core/pipeline';
import { printDoc } from './print';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const psmIdx = args.indexOf('--psm');
const psm = psmIdx >= 0 ? args[psmIdx + 1] : '6';

function decode(file: string) {
  const buf = fs.readFileSync(file);
  if (/\.png$/i.test(file)) {
    const png = PNG.sync.read(buf);
    return { data: png.data, width: png.width, height: png.height };
  }
  return jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
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
  const { page, doc } = await recognizePage(pre.image, { rules: pre.rules, charHeight: pre.charHeight * pre.scale }, recognize);
  const t2 = Date.now();
  fs.writeFileSync(file.replace(/\.\w+$/, '.ocr.json'), JSON.stringify(page, null, 1));
  console.log(`===== ${file}: pre ${t1 - t0}ms (char ${pre.charHeight}px, scale ${pre.scale.toFixed(2)}), ocr ${t2 - t1}ms, strips ${page.strips?.length ?? 0}`);
  if (args.includes('--text')) console.log(page.lines.map((l) => l.text).join('\n'));
  printDoc(doc);
}
await worker.terminate();
