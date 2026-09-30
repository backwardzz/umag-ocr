/**
 * Оценка автозаполнения штрихкодов по каталогу UMAG на сохранённых накладных.
 *   npm run catalog              — Node-OCR (samples/*.ocr.json)
 *   npm run catalog -- --browser — браузерный OCR (samples/*-browser.ocr.json)
 *   npm run catalog -- -v        — со всеми строками
 * Нужен samples/umag_catalog.xlsx (выгрузка «Товары → Экспорт»; в git не хранится).
 * Строки со штрихкодом в накладной — честная проверка: штрихкод прячем и ищем по названию.
 */
import fs from 'node:fs';
import { parseDocument } from '../src/core/parse';
import { parseCatalogData, CatalogIndex } from '../src/core/catalog';

const cat = new CatalogIndex(parseCatalogData(fs.readFileSync('samples/umag_catalog.xlsx')));
const variant = process.argv.includes('--browser') ? '-browser' : '';
const verbose = process.argv.includes('-v');
const stats: Record<string, { ok: number; wrong: number }> = {};
let none = 0, unknownFilled = 0, unknownTotal = 0;
for (const f of fs.readdirSync('samples').filter((x) => x.endsWith(`${variant}.ocr.json`) && (variant || !x.includes('-browser'))).sort()) {
  const doc = parseDocument(JSON.parse(fs.readFileSync(`samples/${f}`, 'utf8')));
  const exp = JSON.parse(fs.readFileSync(`samples/${f.replace(/(-browser)?\.ocr\.json$/, '.expected.json')}`, 'utf8'));
  if (verbose) console.log(`\n== ${f} (${doc.supplier})`);
  doc.items.forEach((it, i) => {
    const e = exp.items[i] ?? {};
    const m = cat.match({ name: it.name, unit: it.unit, supplier: doc.supplier, codes: it.extraCodes, price: it.price });
    const got = m ? `${m.item.barcode} «${m.item.name}» ${m.by}/${m.confidence} ${m.score.toFixed(2)}` : '—';
    if (e.barcode && cat.has(e.barcode)) {
      const good = !!m && (m.item.barcode === e.barcode || cat.get(e.barcode) === m.item);
      if (m) { const s = (stats[m.confidence] ??= { ok: 0, wrong: 0 }); if (good) s.ok++; else s.wrong++; } else none++;
      if (verbose) console.log(`  ${good ? 'OK   ' : m ? 'WRONG' : 'none '} ${it.name.slice(0, 45).padEnd(45)} → ${got}${good ? '' : `   [нужно ${e.barcode} «${cat.get(e.barcode)?.name}»]`}`);
    } else if (!e.barcode) {
      unknownTotal++;
      if (m) unknownFilled++;
      if (verbose) console.log(`  ?     ${it.name.slice(0, 45).padEnd(45)} → ${got}`);
    }
  });
}
console.log('\nСтроки со штрихкодом в накладной (штрихкод спрятан, ищем по названию):');
for (const [c, s] of Object.entries(stats)) console.log(`  ${c.padEnd(6)}: верно ${s.ok}, неверно ${s.wrong}`);
console.log(`  не найдено: ${none}`);
console.log(`Строки без штрихкода в накладной: заполнено ${unknownFilled} из ${unknownTotal}`);
