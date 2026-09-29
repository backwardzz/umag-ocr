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
}

export const DEFAULT_EXPORT: ExportSettings = {
  columns: ['barcode', 'qty', 'name', 'unit'],
  header: false,
  qtyMode: 'pcs',
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

export function buildRows(doc: ParsedDoc, s: ExportSettings): (string | number)[][] {
  const rows: (string | number)[][] = [];
  if (s.header) rows.push(s.columns.map((c) => COLUMN_LABELS[c]));
  for (const it of exportableItems(doc)) {
    const { qty, price, unit } = qtyPrice(it, s.qtyMode);
    rows.push(s.columns.map((c) => {
      switch (c) {
        case 'barcode': return it.barcode ?? '';
        case 'qty': return qty ?? '';
        case 'price': return price ?? '';
        case 'name': return it.name;
        case 'sum': return it.sum ?? '';
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
      ['№', 'Штрихкод', 'Код поставщика', 'Наименование', 'Ед.', 'Кол-во', 'Упаковка', 'Цена с НДС', 'Сумма с НДС', 'НДС', 'Замечания'],
    ];
    for (const it of d.items) {
      rows.push([
        it.n, it.barcode ?? '', it.code ?? '', it.name, it.unit ?? '', it.qty ?? '',
        it.pack ? `${it.pack.count} x ${it.pack.size}` : '', it.price ?? '', it.sum ?? '', it.vat ?? '',
        it.issues.filter((x) => x.level !== 'info').map((x) => x.text).join('; '),
      ]);
    }
    rows.push([], ['', '', '', 'Итого по строкам', '', '', '', '', round2(d.items.reduce((a, b) => a + (b.sum ?? 0), 0))]);
    if (d.totals?.sum !== undefined) rows.push(['', '', '', 'Итого по накладной', '', '', '', '', d.totals.sum]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 4 }, { wch: 15 }, { wch: 12 }, { wch: 45 }, { wch: 6 }, { wch: 8 }, { wch: 10 }, { wch: 11 }, { wch: 12 }, { wch: 10 }, { wch: 50 }];
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
