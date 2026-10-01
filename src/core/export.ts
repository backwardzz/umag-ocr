/**
 * Выгрузка для UMAG. Импорт в «Приёмке» (Закупки → Приёмка → «📥 Импорт товаров»)
 * принимает файл или вставку столбцов через Ctrl+V; назначение каждого столбца
 * выбирается в выпадающем списке над ним, для 4 столбцов по умолчанию:
 * Штрихкод, Количество, Название, Ед. изм. Поэтому выгружаем в том же порядке —
 * и без строки заголовка (иначе UMAG примет её за товар).
 */
import * as XLSX from 'xlsx';
import { round2 } from './numbers';
import type { ParsedDoc, ParsedItem } from './types';

export type ExportColumn = 'barcode' | 'qty' | 'price' | 'name' | 'sum' | 'code' | 'unit';

export const COLUMN_LABELS: Record<ExportColumn, string> = {
  barcode: 'Штрихкод',
  qty: 'Количество',
  price: 'Цена закупки',
  name: 'Название',
  sum: 'Сумма',
  code: 'Код поставщика',
  unit: 'Ед. изм',
};

export interface ExportSettings {
  columns: ExportColumn[];
  header: boolean;
  /** Для накладных с упаковками (N x M): количество в штуках или в упаковках */
  qtyMode: 'pcs' | 'packs';
  /** Пересчёт единиц при загрузке накладной: 1 блок = 10 шт (цена и сумма — как в накладной) */
  unitRules: UnitRule[];
}

/** 1 from = factor to: количество умножается на factor, единица становится to */
export interface UnitRule { from: string; to: string; factor: number }

export const DEFAULT_UNIT_RULES: UnitRule[] = [{ from: 'блок', to: 'шт', factor: 10 }];

export const DEFAULT_EXPORT: ExportSettings = {
  columns: ['barcode', 'qty', 'name', 'unit'],
  header: false,
  qtyMode: 'pcs',
  unitRules: DEFAULT_UNIT_RULES,
};

/** Количество, цена и единица с учётом режима упаковок */
export function qtyPrice(it: ParsedItem, mode: ExportSettings['qtyMode']): { qty?: number; price?: number; unit?: string } {
  if (mode === 'packs' && it.pack && it.qty !== undefined && it.sum !== undefined) {
    const qty = it.qty / it.pack.size;
    return { qty, price: round2(it.sum / qty), unit: 'уп' };
  }
  return { qty: it.qty, price: it.price, unit: it.unit };
}

export function exportableItems(doc: ParsedDoc): ParsedItem[] {
  return doc.items.filter((it) => it.barcode && it.qty);
}

interface ExportLine {
  it: ParsedItem;
  /** Штрихкод строки файла: свой, а если сложены разные штрихкоды одного товара UMAG — основной штрихкод товара */
  barcode?: string;
  qty?: number; price?: number; unit?: string; sum?: number;
  /** Σ цена × количество — для средней цены */
  pq?: number;
}

/**
 * Ключ слияния строк: товар UMAG, найденный по штрихкоду (в базе вкусы одного товара заведены
 * дополнительными штрихкодами одного товара), иначе — сам штрихкод. Одинаковое название не повод:
 * у разных товаров UMAG названия бывают одинаковыми («Мармелад Strike 70г» по 129 и по 153 ₸).
 */
function mergeKey(it: ParsedItem): string {
  return it.catalogBarcode ? `prod:${it.catalogBarcode}` : `bc:${it.barcode}`;
}

/**
 * Строки файла. Одинаковые штрихкоды (бонусный товар отдельной строкой по 1 ₸,
 * одна позиция на двух страницах) складываем: UMAG при импорте ищет товар по штрихкоду,
 * и две строки с одним штрихкодом могут не сложиться. Так же складываем разные штрихкоды
 * одного товара UMAG (см. mergeKey). Цена — средняя, взвешенная по количеству (а не сумма / количество:
 * после пересчёта «1 блок = 10 шт» цена остаётся ценой блока, как в накладной).
 */
export function exportLines(doc: ParsedDoc, s: ExportSettings): ExportLine[] {
  const byKey = new Map<string, ExportLine>();
  for (const it of exportableItems(doc)) {
    const { qty, price, unit } = qtyPrice(it, s.qtyMode);
    const sum = it.sum ?? (qty !== undefined && price !== undefined ? round2(qty * price) : undefined);
    const key = mergeKey(it);
    const prev = byKey.get(key);
    const pq = (price ?? 0) * (qty ?? 0);
    if (!prev) {
      byKey.set(key, { it, barcode: it.barcode, qty, price, unit, sum, pq });
      continue;
    }
    if (prev.barcode !== it.barcode) prev.barcode = it.catalogBarcode ?? prev.barcode;
    prev.qty = Math.round(((prev.qty ?? 0) + (qty ?? 0)) * 1000) / 1000;
    prev.sum = round2((prev.sum ?? 0) + (sum ?? 0));
    prev.pq = (prev.pq ?? 0) + pq;
    if (prev.qty) prev.price = round2(prev.pq / prev.qty);
  }
  return [...byKey.values()];
}

/** Сколько строк накладной сольются с другими в файле (одинаковый штрихкод или товар UMAG) */
export function mergedLineCount(doc: ParsedDoc): number {
  const items = exportableItems(doc);
  return items.length - new Set(items.map(mergeKey)).size;
}

export function buildRows(doc: ParsedDoc, s: ExportSettings): (string | number)[][] {
  const rows: (string | number)[][] = [];
  if (s.header) rows.push(s.columns.map((c) => COLUMN_LABELS[c]));
  for (const { it, barcode, qty, price, unit, sum } of exportLines(doc, s)) {
    rows.push(s.columns.map((c) => {
      switch (c) {
        case 'barcode': return barcode ?? '';
        case 'qty': return qty ?? '';
        case 'price': return price ?? '';
        case 'name': return it.name;
        case 'sum': return sum ?? '';
        case 'code': return it.code ?? '';
        case 'unit': return unit ?? '';
      }
    }));
  }
  return rows;
}

export function toTsv(rows: (string | number)[][]): string {
  // Десятичный разделитель — точка: UMAG — веб-приложение, парсит как JS-число
  return rows.map((r) => r.map((v) => String(v).replace(/[\t\n]/g, ' ')).join('\t')).join('\n');
}

export function toXlsxBlob(rows: (string | number)[][], columns: ExportColumn[], sheetName = 'Приемка'): Blob {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  // Штрихкоды и коды — строго текстом, иначе Excel превратит их в 4,82308E+12
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
  columns.forEach((c, ci) => {
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: ci })];
      if (!cell) continue;
      if (c === 'barcode' || c === 'code') { cell.t = 's'; cell.v = String(cell.v); cell.z = '@'; }
      if ((c === 'price' || c === 'sum') && cell.t === 'n') cell.z = '0.00';
    }
  });
  ws['!cols'] = columns.map((c) => ({ wch: c === 'name' ? 48 : c === 'barcode' ? 16 : c === 'unit' ? 8 : 12 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** Подробный отчёт: все поля, включая строки без штрихкода и замечания */
export function toReportBlob(docs: ParsedDoc[]): Blob {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  for (const d of docs) {
    const rows: (string | number)[][] = [
      ['Поставщик', d.supplier ?? '', '№', d.number ?? '', 'Дата', d.date ?? ''],
      [],
      ['№', 'Штрихкод', 'Код поставщика', 'Наименование', 'Наименование в накладной', 'Ед.', 'Кол-во', 'Упаковка', 'Цена с НДС', 'Сумма с НДС', 'НДС', 'Замечания'],
    ];
    for (const it of d.items) {
      rows.push([
        it.n, it.barcode ?? '', it.code ?? '', it.name, it.invoiceName && it.invoiceName !== it.name ? it.invoiceName : '', it.unit ?? '', it.qty ?? '',
        it.pack ? `${it.pack.count} x ${it.pack.size}` : '', it.price ?? '', it.sum ?? '', it.vat ?? '',
        [
          ...(it.barcodeSource === 'catalog' ? [it.catalogMatch?.by === 'fix'
            ? `Штрихкод исправлен по каталогу UMAG: в накладной прочитано ${it.ocrBarcode ?? ''}, похожий — «${it.catalogMatch.name}»`
            : `Штрихкод — автозаполнение из каталога UMAG («${it.catalogMatch?.name ?? ''}»), возможна ошибка`] : []),
          ...(it.orig ? [`В накладной: ${it.orig.qty ?? '?'} ${it.orig.unit ?? ''} по ${it.orig.price ?? '?'} ₸`.replace(/\s+/g, ' ')] : []),
          ...it.issues.filter((x) => x.level !== 'info' && !(x.kind === 'ean' && it.barcodeSource !== 'invoice')).map((x) => x.text),
        ].join('; '),
      ]);
    }
    rows.push([], ['', '', '', 'Итого по строкам', '', '', '', '', '', round2(d.items.reduce((a, b) => a + (b.sum ?? 0), 0))]);
    if (d.totals?.sum !== undefined) rows.push(['', '', '', 'Итого по накладной', '', '', '', '', '', d.totals.sum]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 4 }, { wch: 15 }, { wch: 12 }, { wch: 45 }, { wch: 40 }, { wch: 6 }, { wch: 8 }, { wch: 10 }, { wch: 11 }, { wch: 12 }, { wch: 10 }, { wch: 50 }];
    let name = (d.supplier ?? 'Накладная').replace(/[\\/?*[\]:"]/g, '').slice(0, 24) + (d.number ? ` ${d.number}` : '');
    name = name.slice(0, 31);
    let n = 2;
    while (used.has(name)) name = `${name.slice(0, 28)} ${n++}`;
    used.add(name);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function exportFileName(doc: ParsedDoc, ext = 'xlsx'): string {
  const sup = (doc.supplier ?? 'накладная').replace(/ТОО|ИП|["«»]/g, '').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '');
  const parts = ['UMAG', sup || 'накладная', doc.number, doc.date?.replace(/\./g, '-')].filter(Boolean);
  return `${parts.join('_')}.${ext}`;
}
