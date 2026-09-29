import { isValidEan, round2, near } from '../core/numbers';
import { mapKey, supplierKey, type MappingStore } from '../core/mapping';
import type { CatalogIndex } from '../core/catalog';
import { issue, type Issue, type ParsedDoc, type ParsedItem } from '../core/types';

export type DocStatus = 'queued' | 'processing' | 'done' | 'error';

export interface DocEntry {
  id: string;
  fileName: string;
  fileUrl: string;
  status: DocStatus;
  stage?: string;
  progress: number;
  error?: string;
  doc?: ParsedDoc;
  processedUrl?: string;
}

export const docSupplierKey = (doc: ParsedDoc) => supplierKey(doc.supplierBin, doc.supplier);

/** Подставляет штрихкоды из справочника для строк с кодом поставщика */
export function applyMapping(doc: ParsedDoc, mapping: MappingStore): ParsedDoc {
  const sk = docSupplierKey(doc);
  let changed = false;
  const items = doc.items.map((it) => {
    if (it.barcode || !it.code) return it;
    const m = mapping[mapKey(sk, it.code)];
    if (m) {
      changed = true;
      return { ...it, barcode: m.barcode, barcodeSource: 'mapping' as const, issues: it.issues.filter((x) => x.kind !== 'code') };
    }
    // Два прохода OCR прочитали код по-разному — известный справочнику вариант верный
    const alt = it.codeAlt ? mapping[mapKey(sk, it.codeAlt)] : undefined;
    if (!alt) return it;
    changed = true;
    return {
      ...it, code: it.codeAlt, codeAlt: it.code, barcode: alt.barcode, barcodeSource: 'mapping' as const,
      issues: it.issues.filter((x) => x.kind !== 'code'),
    };
  });
  return changed ? { ...doc, items } : doc;
}

/** Проверки, которые зависят от текущих данных (после правок пользователя) */
export function itemProblems(it: ParsedItem, catalog?: CatalogIndex): Issue[] {
  const out: Issue[] = [];
  if (!it.barcode) {
    out.push(issue('error', it.code
      ? `Нет штрихкода для кода поставщика ${it.code} — введите один раз, он запомнится`
      : 'Нет штрихкода — строка не попадёт в файл', 'barcode'));
  } else {
    if (!/^\d+$/.test(it.barcode)) out.push(issue('error', 'Штрихкод должен состоять только из цифр'));
    // Внутренние штрихкоды магазина (начинаются с 2) бывают без контрольной цифры
    else if ((it.barcode.length === 13 || it.barcode.length === 8) && !isValidEan(it.barcode) && !it.barcode.startsWith('2'))
      out.push(issue('warn', 'Контрольная цифра штрихкода не сходится — проверьте'));
    if (catalog && catalog.size > 0 && !catalog.has(it.barcode))
      out.push(issue('warn', 'Такого штрихкода нет в каталоге UMAG — создайте товар или проверьте штрихкод'));
  }
  if (!it.qty) out.push(issue('error', 'Не указано количество'));
  if (it.price === undefined) out.push(issue('error', 'Не указана цена'));
  return out;
}

export function allIssues(it: ParsedItem, catalog?: CatalogIndex): Issue[] {
  const parsed = it.edited ? [] : it.issues;
  return [...itemProblems(it, catalog), ...parsed];
}

export type RowLevel = 'error' | 'warn' | 'todo' | 'ok';

/** 'todo' — единственная проблема строки в том, что не введён штрихкод */
export function worstLevel(issues: Issue[]): RowLevel {
  const rest = issues.filter((i) => i.kind !== 'barcode');
  if (rest.some((i) => i.level === 'error')) return 'error';
  if (rest.some((i) => i.level === 'warn')) return 'warn';
  if (issues.some((i) => i.kind === 'barcode')) return 'todo';
  return 'ok';
}

export interface DocSummary {
  rows: number;
  exportable: number;
  missingBarcode: number;
  errors: number;
  warnings: number;
  sum: number;
  total?: number;
  totalsOk?: boolean;
}

export function summarize(doc: ParsedDoc, catalog?: CatalogIndex): DocSummary {
  let errors = 0, warnings = 0, missingBarcode = 0, exportable = 0;
  for (const it of doc.items) {
    const lvl = worstLevel(allIssues(it, catalog));
    if (lvl === 'error') errors++;
    else if (lvl === 'warn') warnings++;
    if (!it.barcode) missingBarcode++;
    if (it.barcode && it.qty) exportable++;
  }
  const sum = round2(doc.items.reduce((a, b) => a + (b.sum ?? 0), 0));
  const total = doc.totals?.sum;
  return {
    rows: doc.items.length, exportable, missingBarcode, errors, warnings, sum, total,
    totalsOk: total === undefined ? undefined : near(total, sum, 0.05 + doc.items.length * 0.01),
  };
}

/** Правка строки: пересчитываем сумму, помечаем как проверенную пользователем */
export function patchItem(it: ParsedItem, patch: Partial<ParsedItem>): ParsedItem {
  const next: ParsedItem = { ...it, ...patch, edited: true };
  if ('qty' in patch || 'price' in patch) {
    if (next.qty !== undefined && next.price !== undefined) next.sum = round2(next.qty * next.price);
    if (next.pack && next.qty !== undefined) next.pack = { ...next.pack, count: round2(next.qty / next.pack.size) };
  }
  if ('barcode' in patch) next.barcodeSource = patch.barcode ? 'manual' : undefined;
  return next;
}

export function newItem(n: number): ParsedItem {
  return { n, name: '', issues: [], edited: true };
}

export const money = (x?: number) =>
  x === undefined ? '' : x.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, ' ');

export const qtyFmt = (x?: number) =>
  x === undefined ? '' : x.toLocaleString('ru-RU', { maximumFractionDigits: 3 }).replace(/ /g, ' ');
