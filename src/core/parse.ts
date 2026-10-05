/**
 * Определение формата накладной и разбор. Порядок:
 *  1. Ищем известного поставщика по БИН, затем по названию.
 *  2. Нет поставщика — определяем формат по ключевым фразам.
 *  3. Сверяем итоги документа с суммой строк.
 */
import type { OcrPage, StripPlan } from './ocrTypes';
import { pageText } from './layout';
import { extractNumbers, fixDigits, near, round2 } from './numbers';
import { SUPPLIERS, GENERIC_Z2, type SupplierDef, type Z2Options } from './suppliers';
import { parseZ2, planZ2Strips, findNumberAndDate } from './formats/z2';
import { parseSetKola } from './formats/setkola';
import { issue, type ParsedDoc, type ParsedItem } from './types';

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
  // Большинство накладных в РК — форма З-2. Сначала пробуем столбец с EAN, потом с кодами поставщика,
  // потом таблицу без кодов.
  const unknown = !/ОТПУСК\s+ЗАПАСОВ|З-2|3-2/i.test(text);
  const eanOpts: Z2Options = { code: 'ean', nameDir: 'nearest' };
  // (одна строка — тоже накладная, если её количество, цена и сумма прочитаны и сходятся)
  const enough = (doc: ParsedDoc) => doc.items.length >= 2 || (doc.items.length === 1 && (doc.items[0].readings?.support ?? 0) >= 3);
  if (enough(parseZ2(page, eanOpts))) return { kind: 'z2', opts: bestLayout(page, eanOpts), unknown };
  if (enough(parseZ2(page, GENERIC_Z2))) return { kind: 'z2', opts: bestLayout(page, GENERIC_Z2), unknown };
  return { kind: 'z2', opts: { code: 'none', nameDir: 'nearest' }, unknown };
}

/**
 * Неизвестный поставщик: где в строке стоят числа относительно кода — на той же линии,
 * ниже (код у верхнего края многострочной строки) или выше. Если угадать неверно, числа съезжают
 * на соседнюю строку, и это видно только по итогу. Выбираем раскладку, при которой больше строк
 * сходится по арифметике, а сумма строк равна итогу. Считаем по первому проходу OCR (без полос
 * второго прохода) — так план полос и разбор выбирают одно и то же.
 */
function bestLayout(page: OcrPage, base: Z2Options): Z2Options {
  const first: OcrPage = { ...page, strips: undefined };
  const variants: Z2Options[] = [
    base,
    { ...base, rowAlign: 'top', nameDir: 'down' },
    { ...base, rowAlign: 'bottom', nameDir: 'up' },
  ];
  let best = base, bestScore = -1;
  for (const opts of variants) {
    const doc = parseZ2(first, opts);
    const solved = doc.items.filter((it) => (it.readings?.support ?? 0) >= 3).length;
    const rows = round2(doc.items.reduce((a, it) => a + (it.sum ?? 0), 0));
    const totalOk = doc.totals?.sum !== undefined && near(doc.totals.sum, rows, 0.05 + doc.items.length * 0.01);
    // совпадение с итогом весит больше любой разницы в числе сошедшихся строк
    const score = solved + (totalOk ? doc.items.length + 1 : 0);
    // при равенстве остаётся обычная раскладка (она первая)
    if (score > bestScore) { best = opts; bestScore = score; }
  }
  return best;
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
    // Дата из будущего — это срок годности из наименования («(29.01.2027)»), а не дата накладной; номер рядом с ней тоже не тот
    const [d, m, y] = (nd.date ?? '').split('.').map(Number);
    if (!(y && m >= 1 && m <= 12 && new Date(y, m - 1, d).getTime() > Date.now() + 2 * 86400000)) {
      doc.number ??= nd.number;
      doc.date ??= nd.date;
    }
  }
  addTextTotals(doc, page);
  checkTotals(doc);
  return doc;
}

/**
 * Итог из текста под таблицей: «Итого: 45 576,00», «на сумму 77 134,00 KZT»,
 * итог строкой ниже слова «ИТОГ:». Нужен, когда в столбце сумм итог не прочитан.
 */
function addTextTotals(doc: ParsedDoc, page: OcrPage) {
  if (!doc.items.length) return;
  const rows = round2(doc.items.reduce((a, it) => a + (it.sum ?? 0), 0));
  const tol = 0.05 + doc.items.length * 0.01;
  if (doc.totals?.sum !== undefined && near(doc.totals.sum, rows, tol)) return;
  const found: number[] = [];
  page.lines.forEach((l, i) => {
    // «в том числе сумма НДС …» стоит сразу под итогом: слово «ИТОГ» жирным OCR читает как «For:», «ито”:».
    // Строку выше берём, только если в ней одно-два числа (в строке товара их больше)
    if (/в\s+том\s+числе.{0,20}НДС/i.test(l.text) && i > 0) {
      const toks = extractNumbers(fixDigits(page.lines[i - 1].text.replace(/[`'’‘"“”„°|\]\[‚]/g, ' ')));
      if (toks.length <= 2) for (const tok of toks) if (tok.hasDecimals && tok.value >= 1) found.push(tok.value);
    }
    // сам итог не прочитан (стёрт у края фото), а «В том числе НДС: 1 529,37» есть — итог = НДС × 116/16
    const vat = l.text.match(/в\s+том\s+числе.{0,12}[НH][ДA][СC]\D{0,60}(\d[\d ]*[.,]\d{2})/i);
    if (vat) {
      const t = (Number(vat[1].replace(/ /g, '').replace(',', '.')) * 116) / 16;
      found.push(Math.abs(t - Math.round(t)) < 0.1 ? Math.round(t) : round2(t));
    }
    // «…, на сумму 6 100 тенге» — сумма без копеек (итог жирным над ней OCR мог не прочитать)
    const whole = l.text.match(/на\s+сумму\s+(\d[\d ]*\d)\s*(?:тенге|тг|kzt)/i);
    if (whole) found.push(Number(whole[1].replace(/ /g, '')));
    // («ито”:» — так OCR читает жирное «ИТОГ:» без последней буквы)
    if (!/[иуй]тог|(?:^|\s)ито[^А-Яа-яA-Za-z]|всего|к\s*оплате|на\s+сумму/i.test(l.text)) return;
    for (const t of [l.text, page.lines[i + 1]?.text ?? '']) {
      // («21840-00» — копейки через дефис; у номера «30-0107804» после двух цифр идут ещё цифры)
      const text = t.replace(/[`'’‘"“”„°|\]\[]/g, ' ').replace(/(\d)-(\d\d)(?!\d)/g, '$1,$2');
      for (const tok of extractNumbers(fixDigits(text))) if (tok.hasDecimals && tok.value >= 1) found.push(tok.value);
    }
  });
  if (!found.length) return;
  const match = found.find((x) => near(x, rows, tol));
  // Итог не может быть намного меньше суммы строк: «Вес: 45,15» рядом со «Всего отпущено…» — не итог
  const plausible = found.filter((x) => x >= rows * 0.5);
  if (match === undefined && !plausible.length) return;
  const totals = doc.totals ?? {};
  if (totals.sum === undefined) totals.sum = match ?? Math.max(...plausible);
  totals.sumAlt = [...(totals.sumAlt ?? []), ...found.filter((x) => x !== totals.sum)];
  doc.totals = totals;
}

function checkTotals(doc: ParsedDoc) {
  if (!doc.items.length) {
    doc.issues.push(issue('error', 'Товары не найдены. Попробуйте переснять фото ровнее и при хорошем освещении.'));
    return;
  }
  let sum = round2(doc.items.reduce((a, it) => a + (it.sum ?? 0), 0));
  const tol = 0.05 + doc.items.length * 0.01;
  // Итог без запятой («4520000» вместо «45 200,00»): в 100 раз больше суммы строк, а после деления — того же порядка
  const t = doc.totals?.sum;
  if (doc.totals && t !== undefined && Number.isInteger(t) && t % 100 === 0 && t >= sum * 50 && t / 100 >= sum * 0.5 && t / 100 <= sum * 2) {
    doc.totals.sum = t / 100;
  }
  if (doc.totals?.sum !== undefined && !near(doc.totals.sum, sum, tol)) {
    // Итог мог быть прочитан с ошибкой — есть второе прочтение, совпадающее со строками?
    const alt = doc.totals.sumAlt?.find((x) => near(x, sum, tol));
    if (alt !== undefined) doc.totals.sum = alt;
    else if (fixRowsByTotal(doc, doc.totals.sum, tol) || fillRowFromTotal(doc, doc.totals.sum)) sum = round2(doc.items.reduce((a, it) => a + (it.sum ?? 0), 0));
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

/**
 * Ровно одна строка не прочитана (нет количества или числа не сходятся), а итог известен:
 * её сумма = итог − остальные строки, количество = сумма / цена (если получается целое или граммы).
 */
function fillRowFromTotal(doc: ParsedDoc, total: number): boolean {
  // Слабые строки: не прочитаны или сошлись меньше чем по трём числам
  const weak = doc.items.filter((it) => it.qty === undefined || it.sum === undefined
    || it.issues.some((x) => x.level === 'error') || (it.readings?.support ?? 3) <= 2);
  const sols: { it: ParsedItem; qty: number; price: number; sum: number }[] = [];
  for (const it of weak) {
    // дробное количество допускаем, только если в накладной есть весовой товар
    const weightDoc = it.unit === 'кг' || doc.items.some((x) => x !== it && x.qty !== undefined && !Number.isInteger(x.qty));
    const others = doc.items.reduce((a, x) => (x === it ? a : a + (x.sum ?? 0)), 0);
    const s = round2(total - others);
    if (s <= 0) continue;
    // Сумма строки должна узнаваться в том, что OCR всё-таки прочитал («472» в «5 472»),
    // иначе итог относится к чему-то ещё (например, ко всей многостраничной накладной)
    const digits = (x: number) => x.toFixed(2).replace(/\.00$/, '').replace('.', '');
    const seen = (it.readings?.sum ?? []).map(digits).filter((d) => d.length >= 2);
    if (!seen.some((d) => digits(s).includes(d) || d.includes(digits(s)))) continue;
    // Прочтения цены идут по надёжности (первый проход, затем второй, затем варианты с потерянной запятой) —
    // берём первое, при котором количество получается целым (или с граммами)
    const prices = [...new Set([...(it.readings?.price ?? []), ...(it.price ? [it.price] : [])])];
    const fit = (whole: boolean) => prices.find((p) => {
      const q = s / p, q3 = Math.round(q * 1000) / 1000;
      return q3 > 0 && q3 < 100000 && Math.abs(q - q3) < 1e-6 && (!whole || Number.isInteger(q3));
    });
    const p = fit(true) ?? (weightDoc ? fit(false) : undefined);
    if (p !== undefined) sols.push({ it, qty: Math.round((s / p) * 1000) / 1000, price: p, sum: s });
    else if (!prices.length && it.qty) sols.push({ it, qty: it.qty, price: round2(s / it.qty), sum: s });
  }
  // Решение должно быть единственным (иначе непонятно, какую строку чинить)
  const whole = sols.filter((x) => Number.isInteger(x.qty));
  const pick = whole.length === 1 ? whole[0] : sols.length === 1 ? sols[0] : undefined;
  if (!pick) return false;
  const it = pick.it;
  it.qty = pick.qty;
  it.price = pick.price;
  const s = pick.sum;
  it.sum = s;
  if (it.vat !== undefined) it.vat = round2((s * 16) / 116);
  it.issues = it.issues.filter((x) => x.level === 'info');
  it.issues.push(issue('warn', 'Строка прочитана не полностью — сумма восстановлена по итогу накладной, сверьте с фото'));
  return true;
}

export const fmt = (x: number) =>
  x.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, ' ');
