/**
 * Пересчёт единиц (1 блок = 10 шт) и массовые правки строк — без OCR, на искусственных данных.
 *   npx tsx scripts/test-units.ts
 */
import { allIssues, applyUnitRules, approveAll, attachPage, awaitsSheet, bulkEdit, fixByTotals, isContinuation, isSamePage, mergePages, patchItem, worstLevel, type DocEntry } from '../src/app/model';
import { issue } from '../src/core/types';
import { buildRows, DEFAULT_EXPORT, DEFAULT_UNIT_RULES, type ExportSettings } from '../src/core/export';
import type { ParsedDoc, ParsedItem } from '../src/core/types';
import { encodeSaudaInvoice, saudaBase, saudaInvoice } from '../src/core/sauda';

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

console.log('Файл для Sauda');
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

console.log('Проверено: снять предупреждения');
// штрихкод с неверной контрольной цифрой — предупреждение; «не удалось прочитать количество» — ошибка разбора
const warnRow = item({ name: 'Айран', barcode: '4870132003258', qty: 3, price: 650, sum: 1950, barcodeSource: 'manual' });
const errRow = item({ name: 'Кефир', barcode: '4870132003258', qty: 3, price: 650, sum: 1950, barcodeSource: 'manual', issues: [issue('error', 'Не удалось прочитать количество')] });
const lvl = (it: ParsedItem) => worstLevel(allIssues(it));
check(lvl(warnRow) === 'warn', 'строка с предупреждением — жёлтая');
const ok1 = patchItem(warnRow, { approved: true });
check(lvl(ok1) === 'ok' && !ok1.edited, '«Проверено»: строка больше не жёлтая, правкой не считается');
check(lvl(patchItem(ok1, { approved: false })) === 'warn', '«вернуть замечания» возвращает предупреждение');
check(lvl(patchItem(errRow, { approved: true })) === 'error', 'ошибка разбора после «Проверено» остаётся');
check(lvl(patchItem(ok1, { barcode: '4870132003259' })) === 'warn', 'новый штрихкод — проверка сбрасывается');
const clean = item({ name: 'Айран', barcode: '4870132003257', qty: 3, price: 650, sum: 1950, barcodeSource: 'invoice' });
const all = approveAll([warnRow, errRow, clean]);
check(all[0].approved === true && all[1].approved === true && all[2] === clean, '«Проверено всё» отмечает только строки с предупреждениями');

// Передача в Sauda: строки как в файле (без штрихкода не идут, одинаковые сложены), всегда в штуках
const saudaDoc: ParsedDoc = { format: 't', formatName: 't', supplier: 'ТОО «Тест»', number: '7', date: '03.10.2026', issues: [], items: [
  item({ name: 'Айран', barcode: '4870132003257', unit: 'шт', qty: 3, price: 650, sum: 1950 }),
  item({ name: 'Айран', barcode: '4870132003257', unit: 'шт', qty: 1, price: 650, sum: 650 }),
  item({ name: 'Без кода', qty: 2, price: 10, sum: 20 }),
] };
const sInv = saudaInvoice(saudaDoc, { ...DEFAULT_EXPORT, qtyMode: 'packs' });
check(sInv.items.length === 1 && sInv.items[0].qty === 4 && sInv.items[0].price === 650 && sInv.supplier === 'ТОО «Тест»', 'в Sauda уходят строки со штрихкодом, одинаковые сложены');
const sCode = encodeSaudaInvoice(sInv);
const sBack = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(sCode.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
check(/^[\w-]+$/.test(sCode) && sBack.items[0].name === 'Айран' && sBack.number === '7', 'накладная кодируется в адрес и читается обратно');
check(saudaBase({ href: 'https://backwardzz.github.io/umag-ocr/', hostname: 'backwardzz.github.io' }) === 'https://backwardzz.github.io/sauda/', 'на Pages Sauda лежит рядом');
check(saudaBase({ href: 'http://localhost:5179/', hostname: 'localhost' }) === 'http://localhost:5181/', 'локально Sauda на порту 5181');
check(saudaBase({ href: 'x', hostname: 'y' }, 'https://my.site/app') === 'https://my.site/app/', 'адрес Sauda можно переопределить');

// Листы одной таблицы (KDV на 3 листах): продолжения без шапки, «Итого» на последнем, добавлены не по порядку
console.log('Склейка листов');
const sheet = (from: number, n: number, extra: Partial<ParsedDoc> = {}): ParsedDoc => ({
  format: 'z2', formatName: 'z2', issues: [], ...extra,
  items: Array.from({ length: n }, (_, i) => item({ n: i + 1, name: `Товар ${from + i}`, barcode: `46${String(from + i).padStart(11, '0')}`, qty: 1, price: 100, sum: 100 })),
});
const p1 = sheet(1, 31, { supplier: 'ТОО "KDV Казахстан"', number: '9528700271', date: '14.10.2026' });
const p2 = sheet(32, 40, { issues: [issue('warn', 'Формат накладной не распознан — разобрано как форма З-2, проверьте внимательно')] });
// итог 7 900 прочитан как 900 (потеряна первая цифра), НДС 16% = 1 089,66 сходится со строками
const p3 = sheet(72, 8, { totals: { sum: 900, vat: 1089.66 } });
check(!isContinuation(p1) && isContinuation(p2) && isContinuation(p3), 'лист без поставщика, номера и даты — продолжение');
const e1: DocEntry = { id: 'a', fileName: '1.jpg', fileUrl: 'u1', status: 'done', progress: 1, doc: p1 };
check(awaitsSheet(e1) && !awaitsSheet({ ...e1, doc: p3 }), 'без «Итого» накладная ждёт следующий лист');
const m13 = mergePages(p1, p3);
const e13: DocEntry = { ...e1, doc: m13, extraPages: [{ fileName: '3.jpg', fileUrl: 'u3' }] };
const j = attachPage(e13, p2, { fileName: '2.jpg', fileUrl: 'u2' });
const names = j.doc!.items.map((x) => x.name);
check(j.doc!.items.length === 79 && names[0] === 'Товар 1' && names[31] === 'Товар 32' && names[78] === 'Товар 79', 'лист 2, добавленный после листа с итогом, встаёт перед ним');
check(j.doc!.items.every((x, i) => x.n === i + 1), 'строки перенумерованы подряд');
check(j.fileUrl === 'u1' && j.extraPages!.map((x) => x.fileUrl).join() === 'u2,u3', 'фото листов в том же порядке');
check(j.doc!.number === '9528700271' && j.doc!.supplier === 'ТОО "KDV Казахстан"' && j.doc!.pageSizes!.join() === '31,40,8', 'шапка с первого листа, границы листов сохранены');
check(j.doc!.totals?.sum === 7900 && j.doc!.issues.some((x) => x.kind === 'vat-total'), 'итог с потерянной цифрой восстановлен по НДС');
check(!j.doc!.issues.some((x) => x.text.startsWith('Формат накладной не распознан')), 'у листа-продолжения нет замечания «формат не распознан»');
check(isSamePage(j.doc!, p2) && !isSamePage(p1, p2), 'тот же лист повторно узнаётся');
const kg: ParsedDoc = { format: 't', formatName: 't', issues: [], totals: { qty: 10.5 }, items: [
  item({ name: 'Мармелад', unit: 'кг', qty: 5, price: 156.2, sum: 781, readings: { price: [1562, 1562], sum: [781], support: 3 } }),
  item({ name: 'Печенье /5', unit: 'кг', qty: 5, price: 1196, sum: 5980, readings: { price: [1196], sum: [5980], support: 4 } }),
  item({ name: 'Печенье', unit: 'кг', qty: 10, price: 100, sum: 1000 }),
  item({ name: 'Вафли', unit: 'шт', qty: 5, price: 105, sum: 525 }),
] };
kg.totals = { qty: 20.5 };
const kgFixed = fixByTotals(kg).items[0];
check(kgFixed.qty === 0.5 && kgFixed.price === 1562 && kgFixed.sum === 781, '«5 кг × 156,20» → «0,5 кг × 1 562» по «Итого» количества');

console.log(fails ? `\nОшибок: ${fails}` : '\nЕдиницы и массовые правки: все проверки пройдены');
process.exit(fails ? 1 : 0);
