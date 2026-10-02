/**
 * Пересчёт единиц (1 блок = 10 шт) и массовые правки строк — без OCR, на искусственных данных.
 *   npx tsx scripts/test-units.ts
 */
import { applyUnitRules, bulkEdit } from '../src/app/model';
import { buildRows, DEFAULT_EXPORT, DEFAULT_UNIT_RULES, type ExportSettings } from '../src/core/export';
import type { ParsedDoc, ParsedItem } from '../src/core/types';

let fails = 0;
const check = (cond: boolean, msg: string) => { if (!cond) { fails++; console.log(`  FAIL: ${msg}`); } else console.log(`  ok: ${msg}`); };

const item = (p: Partial<ParsedItem>): ParsedItem => ({ n: 1, name: '', issues: [], ...p });
const doc: ParsedDoc = {
  format: 'z2', formatName: 'test', supplier: 'ТОО "MAYAN"', issues: [],
  items: [
    item({ name: 'Winston Blue', barcode: '4600000000011', unit: 'блок', qty: 1, price: 11136, sum: 11136 }),
    item({ name: 'Parliament', barcode: '4600000000028', unit: 'Блок', qty: 3, price: 12151, sum: 36453 }),
    item({ name: 'Зажигалка', barcode: '4600000000035', unit: 'шт', qty: 5, price: 150, sum: 750 }),
  ],
};
const settings: ExportSettings = { ...DEFAULT_EXPORT, columns: ['barcode', 'qty', 'name', 'unit', 'price', 'sum'] };

console.log('Пересчёт при загрузке: 1 блок = 10 шт');
const d = applyUnitRules(doc, DEFAULT_UNIT_RULES);
check(d.items[0].qty === 10 && d.items[0].unit === 'шт', '1 блок → 10 шт');
check(d.items[0].price === 1113.6 && d.items[0].sum === 11136, 'цена за пачку — 1 113,60 (блок ÷ 10), сумма как в накладной');
check(d.items[1].price === 1215.1 && d.items[1].sum === 36453, '3 блока по 12 151 → 30 шт по 1 215,10');
check(d.items[0].orig?.qty === 1 && d.items[0].orig?.unit === 'блок' && d.items[0].orig?.price === 11136, 'исходные количество, единица и цена сохранены');
check(d.items[1].qty === 30 && d.items[1].unit === 'шт', '«Блок» с большой буквы тоже пересчитан (3 → 30 шт)');
check(d.items[2] === doc.items[2], 'строка в штуках не тронута');
check(applyUnitRules(d, DEFAULT_UNIT_RULES) === d, 'повторное применение ничего не меняет');
check(applyUnitRules(doc, []) === doc, 'без правил накладная не меняется');

console.log('Файл для UMAG');
const rows = buildRows(d, settings);
check(JSON.stringify(rows[0]) === JSON.stringify(['4600000000011', 10, 'Winston Blue', 'шт', 1113.6, 11136]), `строка файла: ${JSON.stringify(rows[0])}`);
// бонусный блок тем же штрихкодом: 1 блок по 11 136 и 1 блок по 1 ₸ → 20 шт, цена средняя по количеству
const bonus = applyUnitRules({ ...doc, items: [doc.items[0], item({ name: 'Winston Blue', barcode: '4600000000011', unit: 'блок', qty: 1, price: 1, sum: 1 })] }, DEFAULT_UNIT_RULES);
const merged = buildRows(bonus, settings);
check(merged.length === 1 && merged[0][1] === 20 && merged[0][4] === 556.85 && merged[0][5] === 11137,
  `одинаковые штрихкоды складываются: ${JSON.stringify(merged[0])}`);

console.log('Массовые правки');
const x10 = bulkEdit(doc.items, [2], { kind: 'scale', field: 'qty', factor: 10 });
check(x10[2].qty === 50 && x10[2].sum === 750 && x10[2].orig?.qty === 5, 'кол-во × 10: сумма не меняется, исходное запомнено');
const back = bulkEdit(x10, [2], { kind: 'scale', field: 'qty', factor: 1 / 10 });
check(back[2].qty === 5 && back[2].orig?.qty === 5, 'кол-во ÷ 10 возвращает обратно, исходное — первое');
check(x10[0] === doc.items[0] && x10[1] === doc.items[1], 'невыбранные строки не тронуты');
const price = bulkEdit(doc.items, [0, 1], { kind: 'scale', field: 'price', factor: 1 / 10 });
check(price[0].price === 1113.6 && price[1].price === 1215.1 && price[0].sum === 11136, 'цена ÷ 10 вручную, сумма не меняется');
const unit = bulkEdit(doc.items, [0, 1, 2], { kind: 'unit', unit: 'пачка' });
check(unit.every((it) => it.unit === 'пачка') && unit[0].qty === 1, 'единица «пачка» у всех строк, количество не меняется');
const conv = bulkEdit(doc.items, [2], { kind: 'convert', factor: 20, unit: 'пачка' });
check(conv[2].qty === 100 && conv[2].price === 7.5 && conv[2].sum === 750 && conv[2].unit === 'пачка', 'пресет: количество × 20, цена ÷ 20 и новая единица');
const restored = bulkEdit(d.items, [0, 1, 2], { kind: 'restore' });
check(restored[0].qty === 1 && restored[0].unit === 'блок' && restored[0].price === 11136 && !restored[0].orig, '«Как в накладной»: 1 блок по 11 136');
check(restored[2] === d.items[2], 'строка без правок не меняется');
const packs = bulkEdit([item({ qty: 72, unit: 'шт', price: 10, sum: 720, pack: { count: 3, size: 24 } })], [0], { kind: 'scale', field: 'qty', factor: 2 });
check(packs[0].pack?.count === 6, 'упаковки «N x M» следуют за количеством');

console.log(fails ? `\nОшибок: ${fails}` : '\nЕдиницы и массовые правки: все проверки пройдены');
process.exit(fails ? 1 : 0);
