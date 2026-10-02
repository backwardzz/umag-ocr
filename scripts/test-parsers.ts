/**
 * Быстрая проверка парсеров на сохранённых результатах OCR (samples/*.ocr.json),
 * без повторного распознавания. Эталоны — samples/*.expected.json (если есть).
 * Для каждой накладной дополнительно собирается Excel для UMAG и читается обратно.
 *   npm test                 — кратко
 *   npm test -- -v           — со всеми строками
 *   npm test -- --no-strips  — только первый проход OCR (когда полосы записаны старым планом)
 *   npm test -- prima        — только файлы, в имени которых есть «prima»
 * Если есть samples/umag_catalog.xlsx, штрихкоды с ошибкой OCR исправляются по каталогу, как в приложении.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { parseDocument } from '../src/core/parse';
import { buildRows, toXlsxBlob, DEFAULT_EXPORT, COLUMN_LABELS, type ExportColumn } from '../src/core/export';
import type { OcrPage } from '../src/core/ocrTypes';
import type { ParsedDoc } from '../src/core/types';
import { printDoc } from './print';
import { CatalogIndex, parseCatalogData } from '../src/core/catalog';
import { catalogFix } from '../src/app/model';

const verbose = process.argv.includes('-v');
const dir = 'samples';
if (!fs.existsSync(dir)) {
  console.log('Нет папки samples/ — положите туда фото и прогоните: npm run ocr -- samples/<фото>.jpg');
  process.exit(0);
}
const catalogFile = path.join(dir, 'umag_catalog.xlsx');
const catalog = fs.existsSync(catalogFile) ? new CatalogIndex(parseCatalogData(fs.readFileSync(catalogFile))) : undefined;

/** Excel для UMAG: штрихкод, название и единица — текстом, количество и цена — числами */
async function checkExcel(doc: ParsedDoc): Promise<string[]> {
  const withCodes: ParsedDoc = { ...doc, items: doc.items.map((it, i) => ({ ...it, barcode: it.barcode ?? `20000000${String(i).padStart(5, '0')}` })) };
  const columns: ExportColumn[] = DEFAULT_EXPORT.columns;
  const rows = buildRows(withCodes, { ...DEFAULT_EXPORT, columns });
  const wb = XLSX.read(Buffer.from(await toXlsxBlob(rows, columns).arrayBuffer()));
  const ws = wb.Sheets[wb.SheetNames[0]];
  const errs: string[] = [];
  rows.forEach((r, i) => {
    columns.forEach((c, ci) => {
      const cell = ws[XLSX.utils.encode_cell({ r: i, c: ci })];
      if (r[ci] === '') return;
      const type = c === 'qty' || c === 'price' ? 'n' : 's';
      if (cell?.t !== type || cell.v !== r[ci]) errs.push(`Excel строка ${i + 1}: ${COLUMN_LABELS[c]} ${JSON.stringify(cell?.v)} (${cell?.t})`);
    });
  });
  return errs;
}

let failed = 0;
const noStrips = process.argv.includes('--no-strips');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const digits = (x?: string) => (x ?? '').replace(/\D/g, '').replace(/^0+/, '');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ocr.json') && (!only.length || only.some((o) => x.includes(o)))).sort()) {
  const page: OcrPage = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (noStrips) delete page.strips;
  const doc = parseDocument(page);
  // С каталогом UMAG (как в приложении) штрихкоды с ошибкой OCR исправляются на похожие из каталога
  if (catalog) {
    const fixed: string[] = [];
    doc.items = doc.items.map((it) => {
      const fix = catalogFix(it, doc, catalog);
      if (!fix) return it;
      fixed.push(`${it.barcode} → ${fix.barcode}`);
      return { ...it, barcode: fix.barcode };
    });
    if (fixed.length) console.log(`  штрихкоды исправлены по каталогу: ${fixed.join(', ')}`);
  }
  console.log(`\n===== ${f}: ${doc.supplier ?? 'поставщик не определён'}, ${doc.items.length} поз.`);
  if (verbose) printDoc(doc);
  const errs = await checkExcel(doc);
  // 1-browser.ocr.json проверяется по 1.expected.json
  const expFile = path.join(dir, f.replace(/(-[\w]+)?\.ocr\.json$/, '.expected.json'));
  if (fs.existsSync(expFile)) {
    const exp: {
      supplier?: string; number?: string; date?: string;
      /** known — известное ограничение строки (для всех вариантов OCR или по варианту): расхождения печатаются, но не считаются ошибкой */
      items: { code?: string; barcode?: string; qty: number; price: number; sum: number; unit?: string; known?: string | Record<string, string> }[];
      /** Известные ограничения по варианту OCR ('browser' / 'node'): печатаются, но не считаются ошибкой */
      knownIssues?: Record<string, string>;
    } = JSON.parse(fs.readFileSync(expFile, 'utf8'));
    // вариант OCR — суффикс файла: 1-browser.ocr.json → browser, 1-x15.ocr.json (фото в 1,5 раза крупнее) → x15
    const variant = f.match(/-([a-z0-9]+)\.ocr\.json$/)?.[1] ?? 'node';
    const known = exp.knownIssues?.[variant];
    if (exp.supplier && !(doc.supplier ?? '').toLowerCase().includes(exp.supplier.toLowerCase())) errs.push(`поставщик ${doc.supplier}, ожидался ${exp.supplier}`);
    // Шапку OCR читает хуже таблицы (69236 вместо 59236), это замечание, а не ошибка разбора
    const notes: string[] = [];
    if (exp.number && digits(doc.number) !== digits(exp.number)) notes.push(`номер ${doc.number}, ожидался ${exp.number}`);
    if (exp.date && doc.date !== exp.date) notes.push(`дата ${doc.date}, ожидалась ${exp.date}`);
    if (notes.length) console.log(`  шапка: ${notes.join('; ')}`);
    if (exp.items.length !== doc.items.length) errs.push(`строк ${doc.items.length}, ожидалось ${exp.items.length}`);
    exp.items.forEach((e, i) => {
      const it = doc.items[i];
      if (!it) return;
      const rowErrs: string[] = [];
      for (const k of ['code', 'barcode', 'qty', 'price', 'sum', 'unit'] as const) {
        if (e[k] !== undefined && it[k] !== e[k]) rowErrs.push(`строка ${i + 1}: ${k} = ${it[k]}, ожидалось ${e[k]}`);
      }
      const knownRow = typeof e.known === 'string' ? e.known : e.known?.[variant];
      if (knownRow && rowErrs.length) console.log(`  известное ограничение, ${rowErrs.join('; ')} — ${knownRow}`);
      else errs.push(...rowErrs);
    });
    if (known && errs.length) {
      console.log(`  известное ограничение: ${known}\n    ${errs.join('\n    ')}`);
      errs.length = 0;
    }
  }
  const totals = doc.issues.find((x) => x.kind === 'totals');
  if (totals) console.log(`  ${totals.text}`);
  if (errs.length) { failed++; console.log(`  FAIL:\n    ${errs.join('\n    ')}`); } else console.log(fs.existsSync(expFile) ? '  OK: совпадает с эталоном' : '  OK');
}
console.log(failed ? `\nОшибок: ${failed}` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
