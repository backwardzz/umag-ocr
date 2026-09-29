/**
 * Быстрая проверка парсеров на сохранённых результатах OCR (samples/*.ocr.json),
 * без повторного распознавания. Эталоны — samples/*.expected.json (если есть).
 * Для каждой накладной дополнительно собирается Excel для UMAG и читается обратно.
 *   npm test          — кратко
 *   npm test -- -v    — со всеми строками
 */
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { parseDocument } from '../src/core/parse';
import { buildRows, toXlsxBlob, DEFAULT_EXPORT } from '../src/core/export';
import type { OcrPage } from '../src/core/ocrTypes';
import type { ParsedDoc } from '../src/core/types';
import { printDoc } from './print';

const verbose = process.argv.includes('-v');
const dir = 'samples';
if (!fs.existsSync(dir)) {
  console.log('Нет папки samples/ — положите туда фото и прогоните: npm run ocr -- samples/<фото>.jpg');
  process.exit(0);
}

/** Excel для UMAG: штрихкод — текстом, количество и цена — числами */
async function checkExcel(doc: ParsedDoc): Promise<string[]> {
  const withCodes: ParsedDoc = { ...doc, items: doc.items.map((it, i) => ({ ...it, barcode: it.barcode ?? `20000000${String(i).padStart(5, '0')}` })) };
  const rows = buildRows(withCodes, DEFAULT_EXPORT);
  const wb = XLSX.read(Buffer.from(await toXlsxBlob(rows, DEFAULT_EXPORT.columns).arrayBuffer()));
  const ws = wb.Sheets[wb.SheetNames[0]];
  const errs: string[] = [];
  rows.forEach((r, i) => {
    const [a, b, c] = ['A', 'B', 'C'].map((col) => ws[`${col}${i + 1}`]);
    if (a?.t !== 's' || a.v !== r[0]) errs.push(`Excel строка ${i + 1}: штрихкод ${JSON.stringify(a?.v)} (${a?.t})`);
    if (b?.t !== 'n' || b.v !== r[1]) errs.push(`Excel строка ${i + 1}: количество ${JSON.stringify(b?.v)}`);
    if (c?.t !== 'n' || c.v !== r[2]) errs.push(`Excel строка ${i + 1}: цена ${JSON.stringify(c?.v)}`);
  });
  return errs;
}

let failed = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ocr.json')).sort()) {
  const page: OcrPage = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const doc = parseDocument(page);
  console.log(`\n===== ${f}: ${doc.supplier ?? 'поставщик не определён'}, ${doc.items.length} поз.`);
  if (verbose) printDoc(doc);
  const errs = await checkExcel(doc);
  // 1-browser.ocr.json проверяется по 1.expected.json
  const expFile = path.join(dir, f.replace(/(-[\w]+)?\.ocr\.json$/, '.expected.json'));
  if (fs.existsSync(expFile)) {
    const exp: { items: { code?: string; barcode?: string; qty: number; price: number; sum: number }[] } = JSON.parse(fs.readFileSync(expFile, 'utf8'));
    if (exp.items.length !== doc.items.length) errs.push(`строк ${doc.items.length}, ожидалось ${exp.items.length}`);
    exp.items.forEach((e, i) => {
      const it = doc.items[i];
      if (!it) return;
      for (const k of ['code', 'barcode', 'qty', 'price', 'sum'] as const) {
        if (e[k] !== undefined && it[k] !== e[k]) errs.push(`строка ${i + 1}: ${k} = ${it[k]}, ожидалось ${e[k]}`);
      }
    });
  }
  const totals = doc.issues.find((x) => x.kind === 'totals');
  if (totals) console.log(`  ${totals.text}`);
  if (errs.length) { failed++; console.log(`  FAIL:\n    ${errs.join('\n    ')}`); } else console.log(fs.existsSync(expFile) ? '  OK: совпадает с эталоном' : '  OK');
}
console.log(failed ? `\nОшибок: ${failed}` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
