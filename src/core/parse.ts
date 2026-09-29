/**
 * Определение формата накладной и разбор. Порядок:
 *  1. Ищем известного поставщика по БИН, затем по названию.
 *  2. Нет поставщика — определяем формат по ключевым фразам.
 *  3. Сверяем итоги документа с суммой строк.
 */
import type { OcrPage, StripPlan } from './ocrTypes';
import { pageText } from './layout';
import { fixDigits, near, round2 } from './numbers';
import { SUPPLIERS, GENERIC_Z2, type SupplierDef, type Z2Options } from './suppliers';
import { parseZ2, planZ2Strips, findNumberAndDate } from './formats/z2';
import { parseSetKola } from './formats/setkola';
import { issue, type ParsedDoc } from './types';

export type { ParsedDoc, ParsedItem } from './types';

export function detectSupplier(page: OcrPage): SupplierDef | undefined {
  const text = pageText(page);
  const digits = fixDigits(text).replace(/[^\d\n ]/g, ' ');
  // БИН надёжнее названия, но в накладной есть и БИН покупателя — берём первого найденного поставщика
  let best: { s: SupplierDef; pos: number } | undefined;
  for (const s of SUPPLIERS) {
    for (const bin of s.bins) {
      const pos = digits.replace(/ /g, '').indexOf(bin);
      if (pos >= 0 && (!best || pos < best.pos)) best = { s, pos };
    }
  }
  if (best) return best.s;
  for (const s of SUPPLIERS) if (s.keywords.some((k) => k.test(text))) return s;
  return undefined;
}

type FormatChoice =
  | { kind: 'setkola'; supplier?: SupplierDef }
  | { kind: 'z2'; opts: Z2Options; supplier?: SupplierDef; unknown: boolean };

function chooseFormat(page: OcrPage): FormatChoice {
  const text = pageText(page);
  const supplier = detectSupplier(page);
  if (supplier?.parser === 'setkola') return { kind: 'setkola', supplier };
  if (supplier?.parser === 'z2') return { kind: 'z2', opts: supplier.z2 ?? GENERIC_Z2, supplier, unknown: false };
  if (/ВСЕГО\s+ПО\s+СЧЕТУ|ЦЕНА\s+ЗА\s+УП/i.test(text)) return { kind: 'setkola' };
  // Большинство накладных в РК — форма З-2. Сначала пробуем столбец с EAN, потом с кодами поставщика.
  const eanOpts: Z2Options = { code: 'ean', nameDir: 'nearest' };
  const opts = parseZ2(page, eanOpts).items.length >= 2 ? eanOpts : GENERIC_Z2;
  return { kind: 'z2', opts, unknown: !/ОТПУСК\s+ЗАПАСОВ|З-2|3-2/i.test(text) };
}

/** Что распознать вторым проходом (узкие полосы столбцов) */
export function planStrips(page: OcrPage): StripPlan[] {
  const f = chooseFormat(page);
  return f.kind === 'z2' ? planZ2Strips(page, f.opts) : [];
}

export function parseDocument(page: OcrPage): ParsedDoc {
  const f = chooseFormat(page);
  const supplier = f.supplier;
  let doc: ParsedDoc;
  if (f.kind === 'setkola') {
    doc = parseSetKola(page);
  } else {
    doc = parseZ2(page, f.opts);
    if (f.unknown) doc.issues.push(issue('warn', 'Формат накладной не распознан — разобрано как форма З-2, проверьте внимательно'));
  }
  if (supplier) {
    doc.supplier = supplier.name;
    doc.supplierBin = supplier.bins[0];
  }
  if (doc.format === 'z2' && (!doc.number || !doc.date)) {
    const nd = findNumberAndDate(page);
    doc.number ??= nd.number;
    doc.date ??= nd.date;
  }
  checkTotals(doc);
  return doc;
}

function checkTotals(doc: ParsedDoc) {
  if (!doc.items.length) {
    doc.issues.push(issue('error', 'Товары не найдены. Попробуйте переснять фото ровнее и при хорошем освещении.'));
    return;
  }
  let sum = round2(doc.items.reduce((a, it) => a + (it.sum ?? 0), 0));
  const tol = 0.05 + doc.items.length * 0.01;
  if (doc.totals?.sum !== undefined && !near(doc.totals.sum, sum, tol)) {
    // Итог мог быть прочитан с ошибкой — есть второе прочтение, совпадающее со строками?
    const alt = doc.totals.sumAlt?.find((x) => near(x, sum, tol));
    if (alt !== undefined) doc.totals.sum = alt;
    else if (fixRowsByTotal(doc, doc.totals.sum, tol)) sum = round2(doc.items.reduce((a, it) => a + (it.sum ?? 0), 0));
  }
  if (doc.totals?.sum !== undefined) {
    if (near(doc.totals.sum, sum, tol)) {
      doc.issues.push(issue('info', `Сумма строк совпадает с итогом накладной: ${fmt(sum)} ₸`, 'totals'));
    } else {
      const diff = round2(doc.totals.sum - sum);
      doc.issues.push(issue('error',
        `Сумма строк ${fmt(sum)} ₸ не равна итогу накладной ${fmt(doc.totals.sum)} ₸ (разница ${fmt(diff)} ₸) — возможно, пропущена или неверно прочитана строка`, 'totals'));
    }
  } else {
    doc.issues.push(issue('warn', `Итог накладной не прочитан, сверка невозможна. Сумма строк: ${fmt(sum)} ₸`, 'totals'));
  }
}

/**
 * Сумма строк не сошлась с итогом: пробуем заменить прочтение одной (или двух)
 * сомнительных строк на альтернативное так, чтобы итог совпал.
 */
function fixRowsByTotal(doc: ParsedDoc, total: number, tol: number): boolean {
  const base = doc.items.reduce((a, it) => a + (it.sum ?? 0), 0);
  const opts: { i: number; alt: { qty: number; price: number; sum: number }; delta: number }[] = [];
  doc.items.forEach((it, i) => {
    for (const alt of it.alternatives ?? []) opts.push({ i, alt, delta: alt.sum - (it.sum ?? 0) });
  });
  const need = total - base;
  const apply = (o: (typeof opts)[number]) => {
    const it = doc.items[o.i];
    it.qty = o.alt.qty;
    it.price = o.alt.price;
    it.sum = o.alt.sum;
    if (it.vat !== undefined) it.vat = round2((o.alt.sum * 16) / 116);
    it.issues = it.issues.filter((x) => x.level === 'info');
    it.issues.push(issue('warn', 'Значения восстановлены по итогу накладной — проверьте строку'));
  };
  const singles = opts.filter((o) => near(o.delta, need, tol));
  if (singles.length === 1) { apply(singles[0]); return true; }
  if (singles.length > 1) return false;
  const pairs: [typeof opts[number], typeof opts[number]][] = [];
  for (let a = 0; a < opts.length; a++) {
    for (let b = a + 1; b < opts.length; b++) {
      if (opts[a].i !== opts[b].i && near(opts[a].delta + opts[b].delta, need, tol)) pairs.push([opts[a], opts[b]]);
    }
  }
  if (pairs.length === 1) { apply(pairs[0][0]); apply(pairs[0][1]); return true; }
  return false;
}

export const fmt = (x: number) =>
  x.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, ' ');
