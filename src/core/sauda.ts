/**
 * Передача накладной в Sauda: кнопка «В Sauda» открывает сайт учёта на странице «Накладная из фото»,
 * где из строк создаётся черновик приёмки. Данные едут в адресе после #, то есть не уходят на сервер:
 * <сайт Sauda>/#/invoice?d=<base64url(JSON)>. Формат разбирает src/lib/invoice.ts в проекте Sauda.
 */
import { exportLines, type ExportSettings } from './export';
import type { ParsedDoc } from './types';

export interface SaudaInvoice {
  v: 1;
  supplier: string;
  number: string;
  date: string;
  items: { barcode: string; name: string; unit: string; qty: number; price: number }[];
}

/** Строки как в файле выгрузки: только со штрихкодом и количеством, одинаковые товары сложены. Всегда в штуках. */
export function saudaInvoice(doc: ParsedDoc, settings: ExportSettings): SaudaInvoice {
  return {
    v: 1,
    supplier: doc.supplier ?? '',
    number: doc.number ?? '',
    date: doc.date ?? '',
    items: exportLines(doc, { ...settings, qtyMode: 'pcs' }).map((l) => ({
      barcode: l.barcode ?? '',
      name: l.it.name,
      unit: l.unit ?? '',
      qty: l.qty ?? 0,
      price: l.price ?? 0,
    })),
  };
}

export function encodeSaudaInvoice(inv: SaudaInvoice): string {
  const bytes = new TextEncoder().encode(JSON.stringify(inv));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Адрес сайта Sauda. На GitHub Pages он лежит рядом (…/umag-ocr/ → …/sauda/), при локальной
 * разработке — на порту 5181. Другой адрес можно задать в localStorage: umag-ocr.saudaUrl.
 */
export function saudaBase(location: { href: string; hostname: string }, override?: string | null): string {
  if (override) return override.endsWith('/') ? override : `${override}/`;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return 'http://localhost:5181/';
  return new URL('../sauda/', location.href).href;
}

export function saudaLink(base: string, doc: ParsedDoc, settings: ExportSettings): string {
  return `${base}#/invoice?d=${encodeSaudaInvoice(saudaInvoice(doc, settings))}`;
}
