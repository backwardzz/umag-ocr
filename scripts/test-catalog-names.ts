/**
 * Названия из каталога UMAG (без OCR, на искусственных данных):
 *  1) штрихкод есть в накладной и в каталоге — название из каталога;
 *  2) штрихкода нет — подбирается по названию из накладной, затем название меняется на каталожное;
 *  3) ручная правка названия, ручной ввод штрихкода, очистка каталога, повторное применение.
 *   npx tsx scripts/test-catalog-names.ts
 */
import { CatalogIndex, type CatalogItem } from '../src/core/catalog';
import { itemMapCode } from '../src/core/mapping';
import type { ParsedDoc, ParsedItem } from '../src/core/types';
import { applyCatalog, applyCatalogNames, enrichDoc, patchItem } from '../src/app/model';
import { isValidEan } from '../src/core/numbers';
import { buildRows, DEFAULT_EXPORT } from '../src/core/export';

const catalogItems: CatalogItem[] = [
  { name: 'Карамель Рошен эвкалипт-ментол 1кг', barcode: '4823077604553', unit: 'кг' },
  { name: 'Сигареты Camel Aroma Red', barcode: '4600000000011', supplier: 'Мегаполис' },
  { name: 'Сигареты Parliament Aqua Blue', barcode: '4600000000028', supplier: 'Мегаполис' },
  { name: 'Chupa Chups ассорти 12г', barcode: '8410031000000' },
  // вкусы одного товара UMAG — дополнительными штрихкодами
  { name: 'Borjomi Energy', barcode: '4860019003623', extra: ['4860019003647', '4860019003685'] },
  // разные товары UMAG с одинаковым названием
  { name: 'Мармелад Strike 70г', barcode: '4680167313029', price: 129 },
  { name: 'Мармелад Strike 70г', barcode: '4607010743475', price: 153 },
];
const catalog = new CatalogIndex(catalogItems);

const item = (p: Partial<ParsedItem>): ParsedItem => ({ n: 1, name: '', qty: 10, price: 100, sum: 1000, issues: [], ...p });
const doc: ParsedDoc = {
  format: 'z2', formatName: 'test', supplier: 'ТОО "ТК "Мегаполис-Казахстан"', supplierBin: '960740000122', issues: [],
  items: [
    item({ name: 'КАРАМЕЛЬ Рошен эвкалипт-ментол КрКФ 1xr', barcode: '4823077604553', barcodeSource: 'invoice' }),
    item({ name: 'Camel Aroma Red', code: '10002269' }),
    item({ name: 'Неизвестный товар без базы', barcode: '4870000000000', barcodeSource: 'invoice' }),
    item({ name: 'PARLTAMENT AQUA BLUE', code: '10000176' }),
    item({ name: 'Товар без штрихкода и без похожих', code: '10009999' }),
  ],
};

let fails = 0;
const check = (cond: boolean, msg: string) => { if (!cond) { fails++; console.log(`  FAIL: ${msg}`); } else console.log(`  ok: ${msg}`); };

console.log('Шаги 1–3: штрихкод из накладной / подбор по названию → название из каталога');
// справочник: код Парламента уже запомнен
const mapping = { '960740000122::10000176': { barcode: '4600000000028', name: 'PARLTAMENT AQUA BLUE', updated: '' } };
let d = enrichDoc(doc, mapping, catalog);
check(d.items[0].name === 'Карамель Рошен эвкалипт-ментол 1кг' && d.items[0].invoiceName === 'КАРАМЕЛЬ Рошен эвкалипт-ментол КрКФ 1xr' && d.items[0].nameSource === 'catalog',
  'EAN из накладной → название из каталога, исходное сохранено');
check(d.items[1].barcode === '4600000000011' && d.items[1].barcodeSource === 'catalog', 'без штрихкода → подобран по названию из накладной');
check(d.items[1].name === 'Сигареты Camel Aroma Red' && d.items[1].invoiceName === 'Camel Aroma Red', '…и название заменено каталожным');
check(d.items[2].name === 'Неизвестный товар без базы' && !d.items[2].nameSource, 'штрихкода нет в каталоге → название из накладной');
check(d.items[3].barcode === '4600000000028' && d.items[3].name === 'Сигареты Parliament Aqua Blue', 'штрихкод из справочника → название из каталога');
check(!d.items[4].barcode && d.items[4].name === 'Товар без штрихкода и без похожих', 'ничего не найдено → строка без изменений');

console.log('Повторное применение ничего не ломает');
const again = applyCatalogNames(applyCatalog(d, catalog), catalog);
check(again.items.every((it, i) => it.name === d.items[i].name && it.invoiceName === d.items[i].invoiceName && it.barcode === d.items[i].barcode),
  'повторный пересчёт даёт тот же результат (поиск идёт по названию из накладной)');

console.log('Ручные правки');
const manualName = applyCatalogNames({ ...d, items: d.items.map((it, i) => (i === 0 ? patchItem(it, { name: 'Мой вариант' }) : it)) }, catalog);
check(manualName.items[0].name === 'Мой вариант' && manualName.items[0].nameSource === 'manual', 'название, исправленное вручную, не заменяется');
check(manualName.items[0].invoiceName === 'КАРАМЕЛЬ Рошен эвкалипт-ментол КрКФ 1xr', '…название из накладной сохранено');
const manualCode = applyCatalogNames({ ...d, items: d.items.map((it, i) => (i === 4 ? patchItem(it, { barcode: '8410031000000' }) : it)) }, catalog);
check(manualCode.items[4].name === 'Chupa Chups ассорти 12г' && manualCode.items[4].invoiceName === 'Товар без штрихкода и без похожих',
  'штрихкод введён вручную → название из каталога');
const confirm = applyCatalogNames({ ...d, items: d.items.map((it, i) => (i === 1 ? patchItem(it, { barcode: it.barcode }) : it)) }, catalog);
check(confirm.items[1].name === 'Сигареты Camel Aroma Red' && confirm.items[1].barcodeSource === 'manual', 'кнопка «верно» сохраняет каталожное название');
check(itemMapCode({ name: 'Сигареты Camel Aroma Red', invoiceName: 'Camel Aroma Red' }) === 'name:camel aroma red',
  'ключ справочника для товара без кода — по названию из накладной');

console.log('Каталог очищен');
const cleared = applyCatalogNames(applyCatalog(d, undefined), undefined);
check(cleared.items[0].name === 'КАРАМЕЛЬ Рошен эвкалипт-ментол КрКФ 1xr' && !cleared.items[0].nameSource, 'названия вернулись к накладной');
check(!cleared.items[1].barcode && cleared.items[1].name === 'Camel Aroma Red', 'автоподобранный штрихкод убран, название из накладной');
check(cleared.items[3].barcode === '4600000000028' && cleared.items[3].name === 'PARLTAMENT AQUA BLUE', 'штрихкод из справочника остался, название из накладной');

console.log('Штрихкод с ошибкой OCR исправляется по каталогу');
// 4823077604553 прочитан как 4823077604563: контрольная цифра не сходится, в каталоге — ровно один похожий
const misread: ParsedDoc = { ...doc, items: [item({ name: 'КАРАМЕЛЬ Рошен', barcode: '4823077604563', code: '4823077604563', barcodeSource: 'invoice' }),
  // соседний вкус той же марки: верный EAN, отличается от каталожного в двух цифрах, названия похожи
  item({ name: 'КАРАМЕЛЬ Рошен эвкалипт', barcode: '4823077604546', barcodeSource: 'invoice' })] };
const fx = applyCatalogNames(applyCatalog(misread, catalog), catalog);
check(fx.items[0].barcode === '4823077604553' && fx.items[0].barcodeSource === 'catalog' && fx.items[0].catalogMatch?.by === 'fix'
  && fx.items[0].ocrBarcode === '4823077604563', 'неверная контрольная цифра, в каталоге один похожий → исправлен');
check(fx.items[0].name === 'Карамель Рошен эвкалипт-ментол 1кг', '…и название из каталога');
check(isValidEan('4823077604546') && fx.items[1].barcode === '4823077604546' && fx.items[1].barcodeSource === 'invoice',
  'верный EAN, которого нет в каталоге (новый товар или соседний вкус), не трогаем');
const fxAgain = applyCatalog(fx, catalog);
check(fxAgain.items[0].barcode === '4823077604553' && fxAgain.items[0].ocrBarcode === '4823077604563', 'повторный пересчёт исправления не ломает');
const fxCleared = applyCatalog(fx, undefined);
check(fxCleared.items[0].barcode === '4823077604563' && fxCleared.items[0].barcodeSource === 'invoice' && !fxCleared.items[0].ocrBarcode,
  'каталог очищен → штрихкод как в накладной');

console.log('Файл для UMAG: складываются штрихкоды одного товара UMAG, а не одинаковые названия');
const flavors: ParsedDoc = { ...doc, items: [
  item({ name: 'энергетик оригинальный', barcode: '4860019003623', qty: 5, price: 631, sum: 3155, barcodeSource: 'invoice' }),
  item({ name: 'энергетик вишня', barcode: '4860019003647', qty: 5, price: 631, sum: 3155, barcodeSource: 'invoice' }),
  item({ name: 'энергетик цитрус', barcode: '4860019003685', qty: 1, price: 1, sum: 1, barcodeSource: 'invoice' }),
  item({ name: 'Strike Огурец', barcode: '4680167313029', qty: 5, price: 129, sum: 645, barcodeSource: 'invoice' }),
  item({ name: 'Strike Дринксы', barcode: '4607010743475', qty: 5, price: 153, sum: 765, barcodeSource: 'invoice' }),
] };
const fl = buildRows(enrichDoc(flavors, {}, catalog), DEFAULT_EXPORT);
check(fl.length === 3, `строк в файле: ${fl.length} (вкусы Borjomi — одна строка, два разных мармелада — две)`);
check(fl[0][0] === '4860019003623' && fl[0][1] === 11, 'вкусы одного товара: основной штрихкод товара, количество сложено (5 + 5 + 1)');
check(fl[1][0] === '4680167313029' && fl[2][0] === '4607010743475', 'одинаковое название у разных товаров UMAG — строки не складываются');
const noCat = buildRows(applyCatalogNames(enrichDoc(flavors, {}, catalog), undefined), DEFAULT_EXPORT);
check(noCat.length === 5, 'каталог очищен — каждая строка отдельно');

console.log('Доп. код товара UMAG (колонка D) → основной штрихкод (колонка B)');
{
  const d0: ParsedDoc = { ...doc, items: [
    item({ name: 'Боржоми Энерджи вишня', barcode: '4860019003647', barcodeSource: 'invoice' }),
    item({ name: 'Боржоми Энерджи', barcode: '4860019003623', barcodeSource: 'invoice' }),
  ] };
  const d1 = applyCatalogNames(d0, catalog);
  check(d1.items[0].barcode === '4860019003623' && d1.items[0].altBarcode === '4860019003647', 'доп. код из накладной заменён основным, исходный сохранён');
  check(d1.items[1].barcode === '4860019003623' && d1.items[1].altBarcode === undefined, 'основной штрихкод не трогается');
  check(applyCatalogNames(d1, catalog) === d1, 'повторное применение ничего не меняет');
  const rows = buildRows(d1, { ...DEFAULT_EXPORT, header: false });
  check(rows.length === 1 && rows[0][0] === '4860019003623' && rows[0][1] === 20, `в файле одна строка с основным штрихкодом: ${JSON.stringify(rows[0])}`);
  const typed = applyCatalogNames({ ...d0, items: [patchItem(d0.items[1], { barcode: '4860019003685' })] }, catalog);
  check(typed.items[0].barcode === '4860019003623' && typed.items[0].altBarcode === '4860019003685', 'доп. код, введённый вручную, тоже заменяется');
  const cleared = applyCatalogNames(d1, undefined);
  check(cleared.items[0].barcode === '4860019003647' && cleared.items[0].altBarcode === undefined, 'каталог очищен — возвращается штрихкод из накладной');
}

console.log(fails ? `\nОшибок: ${fails}` : '\nНазвания из каталога: все проверки пройдены');
process.exit(fails ? 1 : 0);
