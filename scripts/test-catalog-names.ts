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

const catalogItems: CatalogItem[] = [
  { name: 'Карамель Рошен эвкалипт-ментол 1кг', barcode: '4823077604553', unit: 'кг' },
  { name: 'Сигареты Camel Aroma Red', barcode: '4600000000011', supplier: 'Мегаполис' },
  { name: 'Сигареты Parliament Aqua Blue', barcode: '4600000000028', supplier: 'Мегаполис' },
  { name: 'Chupa Chups ассорти 12г', barcode: '8410031000000' },
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

console.log(fails ? `\nОшибок: ${fails}` : '\nНазвания из каталога: все проверки пройдены');
process.exit(fails ? 1 : 0);
