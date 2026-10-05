/**
 * Табличные накладные: форма З-2 (приказ МФ РК №562) и похожие на неё
 * упаковочные листы и расходные накладные. Типичные столбцы: №, Наименование,
 * Номенклатурный номер / Штрихкод, Ед. изм., Подлежит отпуску, Отпущено, Цена,
 * Сумма с НДС, Сумма НДС. У разных поставщиков бывают лишние столбцы (коробки,
 * цена по прайсу, скидка, вес), поэтому столбцы определяем не по порядку, а по
 * арифметике: количество × цена = сумма.
 *
 * Алгоритм:
 *  1. Якоря строк — коды в столбце кодов (EAN-8/13 или код поставщика); оставляем
 *     только коды из одного столбца (по x), чтобы отсечь БИН, артикулы и прочие цифры.
 *     Если кодов в накладной нет, якорь — самый правый заполненный столбец чисел.
 *  2. Полоса строки зависит от раскладки: числа на одной линии с кодом (center),
 *     внизу строки под кодом (top — код у верхнего края) или над ним (bottom).
 *  3. Числовые ячейки раскладываем по столбцам по правому краю (числа выровнены вправо),
 *     роли столбцов находим голосованием строк: q × p = s, НДС = s × 16/116.
 *  4. Если был второй проход по столбцам (page.strips), добавляем его прочтения.
 *  5. Каждую строку сверяем по арифметике (reconcile.ts), итог — с «Итого».
 */
import type { OcrPage, OcrStrip, StripPlan } from '../ocrTypes';
import {
  flattenWords, typicalLineHeight, cluster1d, groupCells, cellText, cellX1, cellCy, wordsToText, median, type Word,
} from '../layout';
import { extractNumbers, fixDigits, isValidEan, repairEan, round2, near, amountVariants } from '../numbers';
import { solveRow, sumMatches } from '../reconcile';
import { issue, type ParsedDoc, type ParsedItem } from '../types';
import type { Z2Options } from '../suppliers';

const VAT_RATE = 0.16;
export type Role = 'qtyPlan' | 'qty' | 'price' | 'sum' | 'vat';
type ColRole = Role | 'skip';
const LEGACY_ROLES: Role[] = ['qtyPlan', 'qty', 'price', 'sum', 'vat'];

/** Единицы в ячейках, включая типичные ошибки OCR (wr = шт, kop = кор) */
const UNIT_WORD = String.raw`(?:штука|штук|шт|wr|ur|um|шr|кг|kr|kg|блок|бут|byt|6yr|6ут|бyт|уп|упак|пачка|пач|пак|кор|kop|банка|бан|л)`;
const UNIT_CELL_RE = new RegExp(String.raw`^${UNIT_WORD}\.?$`, 'i');
const TRAILING_UNIT_RE = new RegExp(String.raw`\s*(${UNIT_WORD})\.?$`, 'i');
/** Мусор, который OCR цепляет к числам: кавычки, штрихи, скобки, линии таблицы */
const JUNK_RE = /[`'’‘"“”„«»°*;:|!_~^\\()[\]{}—–]/g;

function cleanCode(text: string): string | undefined {
  // убираем кавычки, апострофы и пр. по краям, но не запятые внутри (это суммы)
  const t = fixDigits(text.replace(/^[^\dA-Za-zА-Яа-я,.]+|[^\dA-Za-zА-Яа-я,.]+$/g, ''));
  return /^\d+$/.test(t) ? t : undefined;
}

/** EAN-8/13; 14 цифр — EAN-13 с лишней цифрой в конце (так печатает учётная программа некоторых поставщиков) */
const eanLike = (c: string) => isValidEan(c) || (c.length === 14 && isValidEan(c.slice(0, 13)));

function codeFits(code: string, opts: Z2Options): boolean {
  if (opts.code === 'ean') return code.length === 8 || (code.length >= 12 && code.length <= 14);
  if (opts.codeLength) return Math.abs(code.length - opts.codeLength) <= 1;
  return code.length >= 5 && code.length <= 14;
}

interface NumCell { num: string; unit?: string }

/** Ячейка с числом (возможно, с единицей после: «12 бут», «1 кор.»); иначе undefined */
export function parseNumCell(raw: string): NumCell | undefined {
  // «‚5 бут» — нижняя кавычка перед числом (в середине «4‚5» — это запятая, её не трогаем)
  let t = raw.replace(JUNK_RE, ' ').replace(/(^|\s)-+|-+(?=\s|$)/g, ' ').replace(/^[‚\s]+|[‚\s]+$/g, '').replace(/\s+/g, ' ').trim();
  let unit: string | undefined;
  const um = t.match(TRAILING_UNIT_RE);
  if (um && um.index !== undefined && /\d/.test(t.slice(0, um.index))) {
    unit = um[1];
    t = t.slice(0, um.index).trim();
  }
  // «$ бут» — одиночная цифра перед единицей, прочитанная как буква (fixDigits такие не трогает)
  if (unit && t.length === 1) t = { $: '5', S: '5', s: '5', З: '3', з: '3', б: '6', O: '0', О: '0', l: '1', I: '1', '|': '1' }[t] ?? t;
  t = fixDigits(t);
  if (!/^[\d\s.,]+$/.test(t) || !/\d/.test(t)) return undefined;
  // длинные коды (NTIN, ТН ВЭД, штрихкоды) — не количества и не суммы
  if (t.split(/\s+/).some((x) => x.replace(/\D/g, '').length >= 10)) return undefined;
  return { num: t, unit };
}

/** Варианты прочтения числа из ячейки с учётом типичных ошибок OCR */
export function readValues(text: string | undefined, role: Role): number[] {
  if (!text) return [];
  const t = text.trim();
  // «5 472» — целое с пробелом-разделителем тысяч (накладные без копеек)
  if (/^\d{1,3}(?: \d{3})+$/.test(t)) return [Number(t.replace(/ /g, ''))];
  // «4 936 00», «1936 00» — OCR потерял запятую перед копейками, осталась только пробелом
  if (role !== 'qty' && role !== 'qtyPlan') {
    const m = t.replace(/[.,]+$/, '').match(/^(\d{1,3}(?: \d{3})*|\d{4,6}) (\d{2})$/);
    if (m) return [Number(`${m[1].replace(/ /g, '')}.${m[2]}`)];
    // «11 618,001» — к копейкам суммы с разделителем тысяч прилип мусор (скобка, линия таблицы):
    // без этого число распадается на «11» и «618,001»
    const g = t.match(/^(\d{1,3}(?: \d{3})+)[.,](\d{2})\d$/);
    if (g) return [Number(`${g[1].replace(/ /g, '')}.${g[2]}`)];
  }
  const toks = extractNumbers(t);
  if (!toks.length) return [];
  const tok = toks.reduce((x, y) => (y.text.length > x.text.length ? y : x));
  if (role === 'qty' || role === 'qtyPlan') {
    // «4 1» (остаток галочки и количество), «24 67» (количество и «бут» с фильтром цифр) —
    // какое из чисел количество, решит сверка с ценой и суммой
    const v = [tok.value, ...(toks.length <= 3 ? toks.filter((t) => t !== tok).map((t) => t.value) : [])];
    // «5,000» (три знака после запятой) OCR читает как «5000»
    if (!tok.hasDecimals && /000$/.test(tok.text) && tok.text.length >= 4) v.push(tok.value / 1000);
    return v;
  }
  const v = amountVariants(tok);
  // «335,007» — к копейкам прилип мусор (галочка, штрих): у денег два знака после запятой
  if (/[.,]\d{3}$/.test(tok.text)) v.push(Math.trunc(tok.value * 100 + 1e-6) / 100);
  return v;
}

interface Anchor {
  cy: number;
  x0: number;
  x1: number;
  code: string;
  /** Слово первого прохода (если якорь найден в нём) */
  word?: Word;
  /** Прочтение кода из полосы второго прохода */
  stripCode?: string;
}

type Cell = { words: Word[]; text: string; x0: number; x1: number; cy: number; num?: NumCell };

function toCell(c: Word[]): Cell {
  const text = cellText(c);
  return { words: c, text, x0: Math.min(...c.map((w) => w.x0)), x1: cellX1(c), cy: cellCy(c), num: parseNumCell(text) };
}

function makeCells(ws: Word[], gap: number): Cell[] {
  // Ячейки собираем в пределах одной строки OCR: иначе при изгибе листа слова соседних строк слипаются
  const byLine = new Map<number, Word[]>();
  for (const w of ws) byLine.set(w.line, [...(byLine.get(w.line) ?? []), w]);
  return [...byLine.values()].flatMap((line) => mergeThousands(groupCells(line, gap), gap)).map(toCell).sort((a, b) => a.x0 - b.x0);
}

/** «11 136,00»: пробел-разделитель тысяч шире обычного промежутка между словами ячейки */
function mergeThousands(groups: Word[][], gap: number): Word[][] {
  for (let i = 0; i < groups.length - 1; i++) {
    const a = groups[i], b = groups[i + 1];
    const ta = cellText(a).replace(JUNK_RE, '').trim(), tb = cellText(b).replace(JUNK_RE, '').trim();
    // (и «4 936 00» — копейки через пробел, когда OCR потерял запятую)
    if (/^\d{1,3}$/.test(ta) && /^\d{3}(?:[.,]\d{1,3}| \d{2})?[.,-]?$/.test(tb) && b[0].x0 - cellX1(a) <= gap * 1.9) {
      groups.splice(i, 2, [...a, ...b]);
      i--;
    }
  }
  return groups;
}

function dedupeByY<T extends { cy: number }>(list: T[], lineH: number): T[] {
  const s = [...list].sort((a, b) => a.cy - b.cy);
  return s.filter((a, i) => i === 0 || Math.abs(a.cy - s[i - 1].cy) > lineH * 0.4);
}

/** Якоря по столбцу кодов: самый населённый (для EAN — с наибольшим числом верных контрольных цифр) */
function findCodeAnchors(words: Word[], opts: Z2Options, lineH: number): Anchor[] {
  const cands: Anchor[] = [];
  for (const w of words) {
    const code = cleanCode(w.text);
    if (code && codeFits(code, opts)) cands.push({ word: w, code, cy: w.cy, x0: w.x0, x1: w.x1 });
  }
  if (opts.nameSide === 'inline') {
    // штрихкод в тексте OCR иногда режет на два слова: «460562701 1819» — склеиваем, если выходит верный EAN-13
    for (let i = 0; i + 1 < words.length; i++) {
      const a = words[i], b = words[i + 1];
      const ca = cleanCode(a.text), cb = cleanCode(b.text);
      if (!ca || !cb || a.line !== b.line || b.x0 - a.x1 > lineH * 1.5) continue;
      const code = ca + cb;
      if (code.length === 13 && isValidEan(code)) cands.push({ word: a, code, cy: (a.cy + b.cy) / 2, x0: a.x0, x1: b.x1 });
    }
  }
  if (!cands.length) return [];
  if (opts.nameSide === 'inline') {
    // Штрихкод в тексте наименования — x у строк разный, столбца нет. Берём 13-значные коды
    // (EAN или похожие: казахстанские и российские начинаются с 4) ниже шапки таблицы
    const header = words.find((w) => /^Количеств/i.test(w.text));
    return dedupeByY(cands.filter((c) => c.code.length >= 13 && (eanLike(c.code) || /^4/.test(c.code))
      && (!header || c.cy > header.cy)), lineH);
  }
  const cl = cluster1d(cands.map((c) => c.x0), lineH * 2);
  const inRange = (m: number[]) => cands.filter((c) => c.x0 >= m[0] && c.x0 <= m[m.length - 1]);
  const score = (m: number[]) => {
    const list = inRange(m);
    return opts.code === 'ean' ? list.filter((c) => eanLike(c.code)).length * 3 + list.length : list.length;
  };
  const best = cl.reduce((a, b) => (score(b.members) > score(a.members) ? b : a));
  let res = inRange(best.members);
  // Для кодов поставщика — оставляем самую частую длину (±1)
  if (opts.code === 'digits' && !opts.codeLength) {
    const len = median(res.map((c) => c.code.length));
    res = res.filter((c) => Math.abs(c.code.length - len) <= 1);
  }
  // Дубликаты (одно слово попало в две строки OCR)
  return dedupeByY(res, lineH);
}

/** Накладная без кодов: якорь — самый правый из самых заполненных столбцов чисел */
function findNumericAnchors(page: OcrPage, words: Word[], lineH: number): Anchor[] {
  const byLine = new Map<number, Word[]>();
  for (const w of words) byLine.set(w.line, [...(byLine.get(w.line) ?? []), w]);
  const cells: Cell[] = [];
  for (const ws of byLine.values()) for (const c of makeCells(ws, lineH * 0.7)) if (c.num && c.x1 > page.width * 0.4) cells.push(c);
  if (!cells.length) return [];
  const cl = cluster1d(cells.map((c) => c.x1), lineH * 1.5);
  const maxCount = Math.max(...cl.map((c) => c.count));
  const col = cl.filter((c) => c.count >= maxCount * 0.8).sort((a, b) => b.center - a.center)[0];
  const lo = col.members[0], hi = col.members[col.members.length - 1];
  const members = cells.filter((c) => c.x1 >= lo && c.x1 <= hi);
  return dedupeByY(members.map((c) => ({ cy: c.cy, x0: c.x0, x1: c.x1, code: '', word: c.words[0] })), lineH);
}

/** Строка «Итого»: слова «Итог…» ниже начала таблицы, сверху вниз */
function findTotalsWords(words: Word[], afterY: number): Word[] {
  return words
    // «ИТОГ» OCR читает и как «Итаго», «УТогГ», «ЙТОГ», «Wroro:» (жирный шрифт)
    .filter((x) => x.cy > afterY && /^[^A-Za-zА-Яа-я]{0,2}(?:[иИuUуУйЙ][тТt][оoОOаАa][гГr]|[WwШш][rт][oо][rг][oо]?\W*$)/.test(x.text))
    .sort((a, b) => a.cy - b.cy);
}

/** Строка нумерации столбцов под шапкой: «1 2 3 4 5 6 7 8 9» */
function isColumnNumbering(cells: Cell[]): boolean {
  const vals = cells.filter((c) => c.num).map((c) => Number(c.num!.num.replace(/\s/g, ''))).filter((v) => Number.isFinite(v));
  if (vals.length < 3) return false;
  let inc = 0;
  for (let i = 1; i < vals.length; i++) if (vals[i] === vals[i - 1] + 1) inc++;
  return vals.every((v) => Number.isInteger(v) && v < 20) && inc >= vals.length - 2;
}

interface Band { top: number; bottom: number }

/** Полосы строк для чисел в зависимости от раскладки */
function numberBands(anchors: Anchor[], opts: Z2Options, lineH: number, pitch: number, totalsTop: number): Band[] {
  const align = opts.rowAlign ?? 'center';
  return anchors.map((a, i) => {
    const prev = anchors[i - 1]?.cy, next = anchors[i + 1]?.cy;
    if (align === 'top') {
      const bottom = next !== undefined ? next - lineH * 0.6 : Math.min(a.cy + Math.max(pitch, lineH * 3), totalsTop);
      return { top: a.cy - lineH * 0.6, bottom };
    }
    if (align === 'bottom') {
      // у первой строки — до шага строк вверх (многострочное наименование, числа на его середине)
      return { top: prev !== undefined ? prev + lineH * 0.6 : a.cy - Math.max(lineH * 1.5, pitch * 0.9), bottom: Math.min(a.cy + lineH * 0.6, totalsTop) };
    }
    // У первой строки числа не выше кода (выше — шапка и нумерация столбцов), у последней — не ниже («Итого»)
    const top = prev !== undefined ? (prev + a.cy) / 2 : a.cy - Math.min(pitch * 0.6, lineH);
    const bottom = next !== undefined ? (next + a.cy) / 2 : Math.min(a.cy + lineH * 0.6, Math.max(a.cy + lineH * 0.3, totalsTop));
    return { top, bottom };
  });
}

/** Полоса наименования: куда переносится длинное название относительно строки с кодом */
function nameBand(anchors: Anchor[], i: number, opts: Z2Options, lineH: number, numBand: Band, pitch: number): Band {
  const a = anchors[i], prev = anchors[i - 1]?.cy, next = anchors[i + 1]?.cy;
  const half = lineH * 0.5;
  // У первой строки нет соседа сверху: длинное наименование (3–4 строки) — на шаг строк вверх
  const firstUp = opts.nameSide === 'inline' || opts.barcodeInName ?Math.max(lineH * 2.6, pitch * 0.9) : lineH * 2.6;
  if (opts.nameDir === 'up') return { top: prev !== undefined ? prev + half : a.cy - firstUp, bottom: a.cy + half };
  // Перенесённый штрихкод начинается со второй строки наименования — первая строка выше кода
  const downTop = opts.codeWrap && prev === undefined ? a.cy - lineH * 1.6 : a.cy - half;
  if (opts.nameDir === 'down') return { top: downTop, bottom: next !== undefined ? next - half : Math.min(a.cy + lineH * 1.8, numBand.bottom + half) };
  // Название по центру строки: у крайних строк — на полшага вверх/вниз (многострочные названия)
  return {
    top: prev !== undefined ? numBand.top : a.cy - pitch * 0.5,
    bottom: next !== undefined ? numBand.bottom : Math.max(numBand.bottom, a.cy + Math.min(pitch * 0.5, lineH * 2)),
  };
}

/** Числа строки по столбцам: для каждого столбца — ближайшая по правому краю ячейка */
function cellsByColumn(cells: Cell[], cols: ColPos[], colTol: number): (Cell | undefined)[] {
  return cols.map((c) => {
    const d = (x: Cell) => Math.abs(x.x1 - colAt(c, x.cy));
    let inCol = cells.filter((x) => x.num && d(x) <= colTol);
    if (!inCol.length) return undefined;
    // Обрывок линии таблицы («[1» у правого края) не должен вытеснять настоящее число столбца
    const digits = (x: Cell) => (x.num?.num.match(/\d/g) ?? []).length;
    if (inCol.some((x) => digits(x) >= 3)) inCol = inCol.filter((x) => digits(x) >= 2);
    return inCol.reduce((p, q) => (d(q) < d(p) ? q : p));
  });
}

/**
 * Правый край столбца на высоте y. Лист, снятый под углом, даёт «веер»: к низу листа
 * столбцы уезжают на полсотни пикселей, и одно среднее положение не подходит верхним строкам.
 */
interface ColPos { center: number; fit?: { x: number; y: number; slope: number } }
const colAt = (c: ColPos, y: number) => (c.fit ? c.fit.x + c.fit.slope * (y - c.fit.y) : c.center);

/**
 * Наклон столбца по его ячейкам (МНК x1 от y, со второго прохода — без выбросов). Без наклона,
 * если ячеек мало, они в одной полосе или снос по высоте таблицы меньше строки — там хватает среднего.
 */
function fitColumn(cells: Cell[], lineH: number): ColPos['fit'] {
  const lsq = (cs: Cell[]) => {
    const my = cs.reduce((acc, c) => acc + c.cy, 0) / cs.length, mx = cs.reduce((acc, c) => acc + c.x1, 0) / cs.length;
    let vy = 0, cov = 0;
    for (const c of cs) { vy += (c.cy - my) ** 2; cov += (c.cy - my) * (c.x1 - mx); }
    return { x: mx, y: my, slope: vy ? Math.max(-0.1, Math.min(0.1, cov / vy)) : 0 };
  };
  if (cells.length < 6) return undefined;
  const span = Math.max(...cells.map((c) => c.cy)) - Math.min(...cells.map((c) => c.cy));
  if (span < lineH * 8) return undefined;
  let fit = lsq(cells);
  const inliers = cells.filter((c) => Math.abs(c.x1 - (fit.x + fit.slope * (c.cy - fit.y))) <= lineH * 0.6);
  if (inliers.length < Math.max(6, cells.length * 0.6)) return undefined;
  fit = lsq(inliers);
  return Math.abs(fit.slope) * span >= lineH ? fit : undefined;
}


/**
 * Роли столбцов по арифметике строк: ищем тройку столбцов (кол-во, цена, сумма),
 * для которой q × p = s выполняется в наибольшем числе строк. Затем НДС (правее суммы)
 * и «подлежит отпуску» (столбец, совпадающий с количеством). Остальные — лишние.
 */
function detectRoles(rows: number[][][], nCols: number): ColRole[] | undefined {
  const allVotes = new Map<string, number>();
  // строки, где тройка сходится не только как «1 × x = x»
  const realVotes = new Map<string, number>();
  for (const row of rows) {
    const seen = new Set<string>(), real = new Set<string>();
    for (let i = 0; i < nCols; i++) for (let j = i + 1; j < nCols; j++) for (let l = j + 1; l < nCols; l++) {
      const k = `${i},${j},${l}`;
      if (row[i].some((q) => q > 0 && row[j].some((p) => p > 0 && row[l].some((s) => sumMatches(s, q, p))))) seen.add(k);
      if (row[i].some((q) => q > 0 && q !== 1 && row[j].some((p) => p > 0 && p !== 1 && row[l].some((s) => sumMatches(s, q, p))))) real.add(k);
    }
    for (const k of seen) allVotes.set(k, (allVotes.get(k) ?? 0) + 1);
    for (const k of real) realVotes.set(k, (realVotes.get(k) ?? 0) + 1);
  }
  // Столбец из одних единиц («Содержание ед.: 1») даёт тройку 1 × кол-во = кол-во в каждой строке.
  // Если есть тройка, которая сходится настоящим умножением хотя бы в половине от этого числа строк, — берём её
  const maxAll = Math.max(0, ...allVotes.values());
  const maxReal = Math.max(0, ...realVotes.values());
  const votes = maxReal >= Math.max(2, maxAll * 0.5)
    ? new Map([...allVotes].filter(([k]) => (realVotes.get(k) ?? 0) >= maxReal * 0.5))
    : allVotes;
  let best: number[] | undefined, bestVotes = 0;
  for (const [k, v] of votes) {
    const t = k.split(',').map(Number);
    // при равенстве — правее: «Отпущено» правее «Подлежит», цена со скидкой правее цены по прайсу
    if (v > bestVotes || (v === bestVotes && best && (t[2] > best[2] || (t[2] === best[2] && (t[1] > best[1] || (t[1] === best[1] && t[0] > best[0])))))) {
      best = t;
      bestVotes = v;
    }
  }
  const filled = rows.filter((r) => r.filter((x) => x.length).length >= 3).length;
  if (!best || bestVotes < Math.min(2, Math.max(1, filled))) return undefined;
  const [qi, pi, si] = best;
  const roles: ColRole[] = new Array(nCols).fill('skip');
  roles[qi] = 'qty';
  roles[pi] = 'price';
  roles[si] = 'sum';
  const rowOk = (row: number[][]) => row[qi].some((q) => row[pi].some((p) => row[si].some((s) => sumMatches(s, q, p))));
  const good = rows.filter(rowOk);
  // Две цены вместо цены и суммы («Цена» и «Цена со скидкой», а столбец «Сумма» обрезан на фото):
  // тройка сходится только в строках с количеством 1, а при количестве 2 и больше «цена» и «сумма» всё равно равны.
  // Тогда правый столбец — цена (со скидкой), а сумму посчитает сверка строки: количество × цена
  const samePrice = (row: number[][]) => row[pi].some((p) => p > 0 && row[si].some((s) => near(p, s, 0.005)));
  const onlyUnits = good.length > 0 && good.every((row) => row[qi].every((q) => q === 1));
  // (количество «1 шт» и «2 шт» иногда попадает в два соседних столбца — смотрим все столбцы левее цены)
  const bigQty = (row: number[][]) => row.slice(0, pi).some((col) => col.some((q) => q > 1 && Number.isInteger(q)));
  const pricePair = rows.filter((row) => bigQty(row) && samePrice(row)).length;
  if (onlyUnits && pricePair >= 1) {
    roles[pi] = 'skip';
    roles[si] = 'price';
    for (const c of [qi - 1, qi + 1]) if (c >= 0 && c < pi) roles[c] = 'qtyPlan';
    return roles;
  }
  // НДС: правее суммы, v ≈ s × 16/116 (или 12/112 для старых накладных)
  let vatCol = -1, vatVotes = 0;
  for (let m = si + 1; m < nCols; m++) {
    const n = good.filter((row) => row[m].some((v) => row[si].some((s) => [0.16, 0.12].some((r) => near(v, round2((s * r) / (1 + r)), 0.03))))).length;
    if (n > vatVotes) { vatVotes = n; vatCol = m; }
  }
  if (vatCol >= 0 && vatVotes >= Math.max(1, good.length * 0.3)) roles[vatCol] = 'vat';
  // «Подлежит отпуску»: столбец рядом с количеством с теми же значениями
  let planCol = -1, planVotes = 0;
  // (только соседний слева: столбец номеров строк «1, 2, 3…» совпадает с количеством в паре строк)
  for (let c = Math.max(0, qi - 1); c < pi; c++) {
    if (c === qi) continue;
    const n = good.filter((row) => row[c].some((v) => row[qi].some((q) => near(v, q, 0.0001)))).length;
    if (n > planVotes || (n === planVotes && planCol >= 0 && Math.abs(c - qi) < Math.abs(planCol - qi))) { planVotes = n; planCol = c; }
  }
  if (planCol >= 0 && planVotes >= Math.max(1, good.length * 0.5)) roles[planCol] = 'qtyPlan';
  return roles;
}

/**
 * Столбец «Сумма» не прочитан (обрезан или стёрт при обработке фото), а итог под таблицей есть: количество и цена —
 * пара столбцов, у которой сумма произведений по строкам равна итогу. Сумму строки посчитает сверка: количество × цена
 */
function rolesByTotal(rows: number[][][], nCols: number, totalsWords?: Word[]): ColRole[] | undefined {
  if (!totalsWords || rows.length < 2) return undefined;
  const totals = extractNumbers(fixDigits(totalsWords.map((w) => w.text).join(' ').replace(JUNK_RE, ' '))).filter((t) => t.hasDecimals).map((t) => t.value);
  for (let i = 0; i < nCols; i++) for (let j = i + 1; j < nCols; j++) {
    if (!rows.every((r) => r[i].length && r[j].length)) continue;
    const sum = round2(rows.reduce((acc, r) => acc + r[i][0] * r[j][0], 0));
    if (sum > 0 && totals.some((t) => near(t, sum, 0.05))) {
      const roles: ColRole[] = new Array(nCols).fill('skip');
      roles[i] = 'qty';
      roles[j] = 'price';
      return roles;
    }
  }
  return undefined;
}

/** «117 / 105,3» (цена без скидки и со скидкой) → одно слово «105,3» на месте всей пары */
function mergeSlashPrices(words: Word[]): Word[] {
  const num = (w?: Word) => !!w && /^\d[\d.,]*$/.test(w.text.replace(/[^\d.,/]/g, '').replace(/[.,]+$/, ''));
  const out: Word[] = [];
  const join = (a: Word, b: Word, text: string): Word => ({ ...a, text, x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), cx: (Math.min(a.x0, b.x0) + Math.max(a.x1, b.x1)) / 2 });
  for (let i = 0; i < words.length; i++) {
    const w = words[i], prev = out[out.length - 1], next = words[i + 1];
    const same = (o?: Word) => !!o && o.line === w.line;
    const t = w.text.replace(/[^\d.,/]/g, '');
    if (/^\d[\d.,]*\/\d[\d.,]*$/.test(t)) out.push({ ...w, text: t.split('/')[1] });
    else if (t === '/' && same(prev) && num(prev) && same(next) && num(next)) { out[out.length - 1] = join(prev, next, next.text); i++; }
    else if (/^\/\d[\d.,]*$/.test(t) && same(prev) && num(prev)) out[out.length - 1] = join(prev, w, t.slice(1));
    else if (/^\d[\d.,]*\/$/.test(t) && same(next) && num(next)) { out.push(join(w, next, next.text)); i++; }
    else out.push(w);
  }
  return out;
}

/**
 * Общий анализ страницы — нужен и для плана второго прохода, и для разбора.
 * stripCodes — коды из второго прохода: уточняют прочтение и добавляют пропущенные строки.
 */
function analyze(page: OcrPage, opts: Z2Options, stripCodes: { cy: number; code: string }[] = []) {
  // копейки через дефис («350-00») читаем как обычные «350,00»
  let words = opts.dashDecimals
    ? flattenWords(page).map((w) => ({ ...w, text: w.text.replace(/(\d)-(\d\d)(?!\d)/, '$1,$2') }))
    : flattenWords(page);
  if (opts.slashPrice) words = mergeSlashPrices(words);
  const lineH = typicalLineHeight(words, page);
  const cellGap = lineH * 0.7;
  let anchors = opts.code === 'none' ? findNumericAnchors(page, words, lineH) : findCodeAnchors(words, opts, lineH);
  if (stripCodes.length && anchors.length) {
    const ref = anchors[0];
    const extra: Anchor[] = [];
    // Строки полосы и таблицы идут в одном порядке, но полоса может быть сдвинута по y
    // на полстроки и больше (высокие строки таблицы) — сопоставляем выравниванием, а не по ближайшему
    const pitch0 = anchors.length > 1 ? median(anchors.slice(1).map((x, k) => x.cy - anchors[k].cy)) : lineH * 1.5;
    const tol = Math.max(lineH * 0.6, pitch0 * 0.3);
    const match = alignSequences(stripCodes.map((s) => s.cy), anchors.map((x) => x.cy), tol);
    stripCodes.forEach((s, k) => {
      if (match[k] >= 0) { anchors[match[k]].stripCode ??= s.code; return; }
      if (anchors.some((x) => Math.abs(x.cy - s.cy) < tol) || extra.some((x) => Math.abs(x.cy - s.cy) < tol)) return;
      extra.push({ cy: s.cy, x0: ref.x0, x1: ref.x1, code: s.code, stripCode: s.code });
    });
    anchors = dedupeByY([...anchors, ...extra], lineH);
  }
  // Коды в шапке над таблицей («Покупатель: <36007568>» — восемь цифр, как EAN-8) — не строки товаров:
  // всё, что выше заголовка столбца «Штрихкод», отбрасываем (если ниже него остаётся большая часть строк)
  if (opts.code !== 'none') {
    const header = words.filter((w) => /^штрих/i.test(w.text.replace(/[^A-Za-zА-Яа-яЁё]/g, ''))).sort((x, y) => x.cy - y.cy)[0];
    if (header) {
      const below = anchors.filter((x) => x.cy > header.cy + lineH * 0.3);
      if (below.length && below.length >= anchors.length * 0.5) anchors = below;
    }
  }
  if (opts.code !== 'none') anchors = fillMissingRows(page, anchors, lineH);
  const empty = {
    words, lineH, anchors, cols: [] as ColX[], roles: [] as ColRole[], numBands: [] as Band[], bandCells: [] as Cell[][],
    pitch: lineH, totalsWords: undefined as Word[] | undefined, numbersLeft: 0, codeCol: { x0: 0, x1: 0 }, cellGap,
    unitCol: undefined as { x0: number; x1: number } | undefined,
  };
  if (!anchors.length) return empty;

  // «Итого» ограничивает таблицу снизу (для накладных без кодов в столбце чисел есть и строка итога)
  // Штрихкод картинкой OCR иногда читает как «ИТОГО» (ФудМастер): «Итого», под которым строк больше, чем над ним, — не итог
  const totalsWord = findTotalsWords(words, anchors[0].cy + lineH * 0.3).find((t) =>
    anchors.filter((x) => x.cy > t.cy + lineH).length <= anchors.filter((x) => x.cy < t.cy - lineH * 0.4).length);
  if (totalsWord) anchors = anchors.filter((a) => a.cy < totalsWord.cy - lineH * 0.4);
  if (!anchors.length) return { ...empty, anchors };
  const totalsWords = totalsWord ? words.filter((x) => Math.abs(x.cy - totalsWord.cy) < (totalsWord.y1 - totalsWord.y0) * 0.8 && x.x0 > totalsWord.x0) : undefined;
  const totalsTop = totalsWord ? totalsWord.cy - lineH * 0.45 : Infinity;

  // Граница, правее которой ищем числа строки
  const codeFirst = anchors.filter((a) => a.code);
  const codeCol = codeFirst.length
    ? { x0: Math.min(...codeFirst.map((a) => a.x0)), x1: median(codeFirst.map((a) => a.x1)) }
    : { x0: 0, x1: 0 };
  const colTol = lineH * 1.5;

  const build = (rows: Anchor[]) => {
    const pitch = rows.length > 1 ? median(rows.slice(1).map((a, i) => a.cy - rows[i].cy)) : lineH * 1.5;
    const bands = numberBands(rows, opts, lineH, pitch, totalsTop);
    let numbersLeft = codeCol.x1 + lineH * 0.3;
    if (opts.code === 'none') {
      // правее начала наименований (левее — столбец №)
      const starts = bands.map((b) => {
        const alpha = words.filter((w) => w.cy > b.top && w.cy <= b.bottom && /[A-Za-zА-Яа-яЁё]{2,}/.test(w.text));
        return alpha.length ? Math.min(...alpha.map((w) => w.x0)) : NaN;
      }).filter((x) => Number.isFinite(x));
      numbersLeft = starts.length ? median(starts) : page.width * 0.2;
    }
    const bandCells = bands.map((b) => {
      const cells = makeCells(words.filter((w) => w.cy > b.top && w.cy <= b.bottom && w.x0 > numbersLeft), cellGap);
      // строка нумерации столбцов «1 2 3 … 9» под шапкой не должна попасть в первую строку товара
      const numbering = new Set<number>();
      for (const line of new Set(cells.map((c) => c.words[0].line))) {
        if (isColumnNumbering(cells.filter((c) => c.words[0].line === line))) numbering.add(line);
      }
      return numbering.size ? cells.filter((c) => !numbering.has(c.words[0].line)) : cells;
    });
    // Числа на одной линии OCR с кодом — самое надёжное прочтение (если раскладка «по центру»)
    // (только слова, которые по высоте ближе к этой строке, чем к соседним: на мятом листе Tesseract
    // склеивает в одну «линию» код одной строки и числа следующей)
    const nearest = (y: number) => rows.reduce((best, r, k) => (Math.abs(r.cy - y) < Math.abs(rows[best].cy - y) ? k : best), 0);
    const lineCells = rows.map((a, i) => ((opts.rowAlign ?? 'center') === 'center' && a.word
      ? makeCells(words.filter((w) => w.line === a.word!.line && w.x0 > numbersLeft && nearest(w.cy) === i), cellGap)
      : []));
    // Ячейки строки: сначала с линии кода, затем остальные из полосы (без дублей)
    const rowCells = rows.map((_, i) => {
      const own = new Set(lineCells[i].flatMap((c) => c.words));
      return [...lineCells[i], ...bandCells[i].filter((c) => !c.words.some((w) => own.has(w)))];
    });

    // Столбцы чисел: кластеры правого края числовых ячеек
    const numericCells = rowCells.flat().filter((c) => c.num);
    const clusters = cluster1d(numericCells.map((c) => c.x1), colTol)
      // (накладная из одной строки: в каждом столбце одно число — роли столбцов всё равно определит арифметика)
      .filter((c) => c.count >= (rows.length === 1 ? 1 : Math.max(2, rows.length * 0.3)))
      .sort((a, b) => a.center - b.center);
    const cols: ColX[] = clusters.map((c, ci) => {
      // слово-мусор с огромной рамкой (печать, линия) не должно раздвигать столбец
      const members = numericCells.filter((x) => Math.abs(x.x1 - c.center) <= colTol && x.x1 - x.x0 < lineH * 6);
      const x0s = members.map((m) => m.x0).sort((a, b) => a - b);
      const prevCenter = ci > 0 ? clusters[ci - 1].center : -Infinity;
      const x0 = Math.max(x0s[Math.floor(x0s.length * 0.1)] ?? c.center - lineH * 4, prevCenter + lineH * 0.5);
      const fit = fitColumn(numericCells.filter((x) => x.x1 >= c.members[0] && x.x1 <= c.members[c.members.length - 1] && x.x1 - x.x0 < lineH * 6), lineH);
      return { center: c.center, x0, x1: Math.max(c.center, ...members.map((m) => m.x1)), fit };
    });
    // Снос от съёмки под углом согласован у всех столбцов: одинаковый (лист повёрнут) или растёт
    // от столбца к столбцу («веер» — лист снят наискосок). Наклон принимаем, только если он найден хотя бы
    // у двух столбцов и согласован (иначе это выбросы — например, цифра из шапки)
    const slopes = cols.map((c) => c.fit?.slope).filter((x): x is number => x !== undefined);
    const abs = slopes.map(Math.abs);
    const monotonic = abs.every((x, i) => i === 0 || x >= abs[i - 1] - 0.003) || abs.every((x, i) => i === 0 || x <= abs[i - 1] + 0.003);
    const agree = slopes.length >= Math.max(2, cols.length * 0.6) && (slopes.every((x) => x > 0) || slopes.every((x) => x < 0))
      && (Math.max(...abs) <= Math.min(...abs) * 2.5 || (monotonic && Math.max(...abs) <= Math.min(...abs) * 6));
    if (!agree) for (const c of cols) c.fit = undefined;

    // Роли столбцов: по арифметике, иначе — как в стандартной З-2 (5 самых правых)
    const readAny = (t: string) => [...new Set([...readValues(t, 'qty'), ...readValues(t, 'price')])];
    const byCol = rowCells.map((cells) => cellsByColumn(cells, cols, colTol));
    const values = byCol.map((cs) => cs.map((c) => (c ? readAny(c.num!.num) : [])));
    // Столбцы, которые арифметика не различает («Кол-во» и «Приз» у Градус компани), — заданы для поставщика явно
    let roles = opts.columns && opts.columns.length === cols.length ? [...opts.columns] : detectRoles(values, cols.length);
    roles ??= rolesByTotal(values, cols.length, totalsWords);
    if (!roles) {
      const n = Math.min(5, cols.length);
      roles = cols.map((_, i) => (i < cols.length - n ? 'skip' : LEGACY_ROLES[5 - n + (i - (cols.length - n))]));
    }
    const roleValues = byCol.map((cs) => cs.filter((c, ci) => c && roles![ci] !== 'skip').length);
    return { rows, pitch, bands, numbersLeft, rowCells, cols, roles, roleValues };
  };

  let b = build(anchors);  if (opts.code === 'none') {
    // Без кодов якорями могут оказаться шапка (нумерация столбцов, реквизиты) — оставляем строки,
    // где заполнены хотя бы два столбца с ролью, и пересчитываем столбцы уже по ним
    const keep = b.rows.filter((_, i) => b.roleValues[i] >= 2 && !isColumnNumbering(b.rowCells[i]));
    if (!keep.length) return { ...empty, anchors: keep };
    if (keep.length !== b.rows.length) b = build(keep);
  }
  const { rows, pitch, bands, numbersLeft, rowCells, cols, roles } = b;
  const unitCol = findUnitColumn(rowCells, cols, roles, rows.length, lineH);
  return { words, lineH, anchors: rows, cols, roles, numBands: bands, bandCells: rowCells, pitch, totalsWords, numbersLeft, codeCol, cellGap, unitCol };
}

/** Левый край чисел строки (столбцы с ролями) */
const rolesLeft = (cols: ColX[], roles: ColRole[]) => Math.min(Infinity, ...cols.filter((_, i) => roles[i] !== 'skip').map((c) => c.x0));

/** Столбец «Ед. изм.»: короткие слова левее чисел, стоящие друг под другом */
function findUnitColumn(rowCells: Cell[][], cols: ColX[], roles: ColRole[], rows: number, lineH: number): { x0: number; x1: number } | undefined {
  // обычно левее всех чисел; в «Реализации товаров» — между количеством и ценой («3  шт  1 789,00»)
  const priceCol = cols[roles.indexOf('price')];
  const left = Math.max(rolesLeft(cols, roles), priceCol?.x0 ?? -Infinity);
  const short = rowCells.flat().filter((c) => !c.num && c.x1 < left - lineH * 0.3 && /^[A-Za-zА-Яа-яЁё.]{1,6}$/.test(c.text.replace(JUNK_RE, '').trim()));
  if (!short.length) return undefined;
  const cx = (c: Cell) => (c.x0 + c.x1) / 2;
  const cl = cluster1d(short.map(cx), lineH * 1.5).filter((c) => c.count >= Math.max(2, rows * 0.3));
  if (!cl.length) return undefined;
  const members = (c: { members: number[] }) => short.filter((s) => cx(s) >= c.members[0] && cx(s) <= c.members[c.members.length - 1]);
  const score = (c: { members: number[] }) => members(c).reduce((a, s) => a + (UNIT_CELL_RE.test(s.text.replace(JUNK_RE, '').trim()) ? 3 : 1), 0);
  const best = cl.reduce((p, q) => (score(q) > score(p) || (score(q) === score(p) && q.center > p.center) ? q : p));
  const m = members(best);
  return { x0: Math.min(...m.map((c) => c.x0)), x1: Math.max(...m.map((c) => c.x1)) };
}

/** Буквы единиц измерения для второго прохода по столбцу «Ед. изм.» */
const UNIT_LETTERS = 'шткгблоупачрнШТКГБЛОУПАЧРН.';

interface ColX extends ColPos { x0: number; x1: number }

/** План второго прохода: полоса кодов и полосы числовых столбцов */
export function planZ2Strips(page: OcrPage, opts: Z2Options): StripPlan[] {
  const a = analyze(page, opts);
  const used = a.roles.map((r, i) => ({ r, i })).filter((x) => x.r !== 'skip');
  if (a.anchors.length < 2 || used.length < 2) return [];
  const { lineH, anchors, cols } = a;
  // запас сверху на целую строку: первую строку товара первый проход часто теряет (она прижата к шапке)
  const top = anchors[0].cy - Math.max(a.pitch * 1.3, lineH * 2.5) - (opts.rowAlign === 'bottom' ? lineH * 2 : 0);
  // запас снизу: последняя строка могла не найтись в первом проходе + строка «Итого»
  const bottom = anchors[anchors.length - 1].cy + Math.max(lineH * 4.5, a.pitch * 2.5) + (opts.rowAlign === 'top' ? lineH * 3 : 0);
  const plans: StripPlan[] = [];
  if (opts.code !== 'none') {
    const coded = anchors.filter((x) => x.code);
    const cx0 = Math.min(...coded.map((x) => x.x0)), cx1 = Math.max(...coded.map((x) => x.x1));
    plans.push({ role: 'code', x0: cx0 - lineH * 0.4, x1: cx1 + lineH * 0.4, y0: top, y1: bottom, whitelist: '0123456789' });
  }
  const colTol = lineH * 1.5;
  const colCells = (i: number) => a.bandCells.map((cells) => cellsByColumn(cells, cols, colTol)[i]).filter((c): c is Cell => !!c);
  for (const { r, i } of used) {
    // Количество с единицей в той же ячейке («3 бут»): с фильтром цифр «бут» читается как «6» → «36»
    if (r === 'qty' || r === 'qtyPlan') {
      const cs = colCells(i);
      if (cs.length && cs.filter((c) => c.num?.unit).length >= cs.length * 0.5) continue;
    }
    const c = cols[i];
    const prevRight = i > 0 ? cols[i - 1].x1 : Math.max(a.numbersLeft, a.codeCol.x1);
    const x0 = Math.max(prevRight + lineH * 0.3, c.x0 - lineH * 1.2);
    const nextLeft = i < cols.length - 1 ? cols[i + 1].x0 : page.width;
    let x1 = Math.min(nextLeft - lineH * 0.3, c.x1 + lineH * 0.8);
    if (x1 < c.center + lineH * 0.3) x1 = c.center + lineH * 0.6;
    plans.push({ role: r, x0, x1, y0: top, y1: bottom, whitelist: '0123456789,. ' });
  }
  // «wr», «un», «xr» — так OCR читает «шт» и «кг»; с фильтром букв единица читается уверенно
  // Столбец наименований целиком: от начала названий (без № п/п и соседних листов слева) до столбца кодов
  if (opts.nameStrip && opts.code !== 'none' && (opts.nameSide ?? 'left') === 'left') {
    const right = a.codeCol.x0 - lineH * 0.4;
    const starts = new Map<number, number>();
    for (const w of a.words) {
      if (w.cy < top || w.cy > bottom || w.x1 > right || w.conf < 60 || !/[A-Za-zА-Яа-яЁё]{3,}/.test(w.text)) continue;
      starts.set(w.line, Math.min(starts.get(w.line) ?? Infinity, w.x0));
    }
    const cl = cluster1d([...starts.values()], lineH * 2).sort((x, y) => y.count - x.count)[0];
    if (cl && cl.count >= 3) plans.push({ role: 'name', x0: cl.members[0] - lineH * 0.5, x1: right, y0: top, y1: bottom, whitelist: '' });
  }
  if (a.unitCol) plans.push({ role: 'unit', x0: a.unitCol.x0 - lineH * 0.4, x1: a.unitCol.x1 + lineH * 0.4, y0: top, y1: bottom, whitelist: UNIT_LETTERS });
  return plans;
}

interface StripLine { cy: number; text: string; used?: boolean }

/**
 * Сопоставляет упорядоченные y строк таблицы (a) и строк полосы (b) с сохранением
 * порядка: общий сдвиг оцениваем медианой расстояний до ближайших, затем
 * динамическим программированием минимизируем сумму отклонений (пропуск стоит tol).
 * Возвращает для каждого a индекс в b или -1.
 */
export function alignSequences(a: number[], b: number[], tol: number): number[] {
  const n = a.length, m = b.length;
  if (!n || !m) return a.map(() => -1);
  const nearestDiff = a.map((y) => b.reduce((best, x) => (Math.abs(x - y) < Math.abs(best) ? x - y : best), Infinity));
  const off = median(nearestDiff.filter((d) => Number.isFinite(d) && Math.abs(d) < tol * 2));
  const INF = 1e18;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(INF));
  const how: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  dp[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const cur = dp[i][j];
      if (cur >= INF) continue;
      if (i < n && cur + tol < dp[i + 1][j]) { dp[i + 1][j] = cur + tol; how[i + 1][j] = 1; }
      if (j < m && cur + tol * 0.5 < dp[i][j + 1]) { dp[i][j + 1] = cur + tol * 0.5; how[i][j + 1] = 2; }
      if (i < n && j < m) {
        const d = Math.abs(b[j] - a[i] - off);
        if (d <= tol && cur + d < dp[i + 1][j + 1]) { dp[i + 1][j + 1] = cur + d; how[i + 1][j + 1] = 3; }
      }
    }
  }
  const res = a.map(() => -1);
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const h = how[i][j];
    if (h === 3) { res[i - 1] = j - 1; i--; j--; } else if (h === 1) i--; else j--;
  }
  return res;
}

function stripLines(strip?: OcrStrip): StripLine[] {
  if (!strip) return [];
  return strip.lines
    .map((l) => ({ cy: (l.y0 + l.y1) / 2, text: fixDigits(l.text.trim()) }))
    .filter((l) => /\d/.test(l.text))
    .sort((a, b) => a.cy - b.cy);
}

/** Код из строки полосы: подходящий по длине фрагмент (соседний столбец мог попасть в полосу) */
function stripCode(text: string, opts: Z2Options): string | undefined {
  let parts = text.split(/\s+/).map((p) => p.replace(/\D/g, '')).filter(Boolean);
  // в полосу попал № строки: «2103112» = 2 + 103112
  const len = opts.codeLength;
  if (len) parts = parts.map((p) => (p.length > len && p.length <= len + 2 ? p.slice(-len) : p));
  // к штрихкоду прилип № строки («144640201599253» = 14 + EAN) или цифры наименования («100г / ШК: …» → «100» + EAN)
  if (opts.code === 'ean') {
    parts = parts.map((p) => (p.length > 13 && p.length <= 18 && !eanLike(p)
      && (isValidEan(p.slice(-13)) || (opts.nameSide === 'inline' && p.slice(-13).startsWith('4'))) ? p.slice(-13) : p));
    if (opts.nameSide === 'inline') parts = parts.filter((p) => p.length >= 13);
  }
  const fits = parts.filter((p) => codeFits(p, opts));
  if (opts.code === 'ean') return fits.find(eanLike) ?? fits.sort((x, y) => y.length - x.length)[0];
  if (fits.length) return fits.sort((x, y) => y.length - x.length)[0];
  const joined = parts.join('');
  return codeFits(joined, opts) ? joined : undefined;
}

export function parseZ2(page: OcrPage, opts: Z2Options): ParsedDoc {
  const doc: ParsedDoc = { format: 'z2', formatName: 'Накладная З-2', items: [], issues: [] };
  const stripOf = (role: string) => page.strips?.find((s) => s.role === role);

  const stripCodes = opts.code === 'none' ? [] : stripLines(stripOf('code'))
    .map((l) => ({ cy: l.cy, code: stripCode(l.text, opts) }))
    .filter((x): x is { cy: number; code: string } => !!x.code);
  const a = analyze(page, opts, stripCodes);
  const { words, lineH, anchors, cols, roles, numBands, bandCells, totalsWords, cellGap } = a;
  // строки далеко друг от друга (многострочные названия) — лист сильнее «плывёт», допуск шире
  const alignTol = Math.max(lineH * 0.65, a.pitch * 0.3);
  if (!anchors.length) {
    doc.issues.push(issue('error', opts.code === 'none'
      ? 'Не найдены строки товаров'
      : 'Не найдены строки товаров (столбец «Номенклатурный номер»)'));
    return doc;
  }
  const usedRoles = roles.filter((r) => r !== 'skip') as Role[];
  if (usedRoles.includes('qty') && usedRoles.includes('price') && !usedRoles.includes('sum')) {
    doc.issues.push(issue('warn', 'Столбец «Сумма» на фото не прочитан (обрезан или в тени) — суммы строк посчитаны как количество × цена, сверьте с итогом'));
  } else if (!usedRoles.includes('qty') || !usedRoles.includes('sum')) {
    doc.issues.push(issue('warn', `Не удалось определить столбцы количества и суммы — часть значений может отсутствовать`));
  }

  const colTol = lineH * 1.5;
  const rowCols = bandCells.map((cells) => cellsByColumn(cells, cols, colTol));
  const colOf = (role: Role) => roles.indexOf(role);

  // Где на самом деле стоят числа строки (у некоторых поставщиков — ниже или выше кода)
  const rowY = anchors.map((_, k) => {
    const ys = rowCols[k].filter((c, ci) => c && roles[ci] !== 'skip').map((c) => c!.cy);
    return ys.length ? median(ys) : undefined;
  });
  const known = rowY.map((y, k) => (y === undefined ? undefined : y - anchors[k].cy)).filter((x): x is number => x !== undefined);
  const offset = known.length ? median(known) : 0;
  // Числа строки, найденные заметно не там, где у остальных строк (последняя строка зацепила «Итого»,
  // напечатанное вплотную под ней), — не ориентир: берём обычное положение относительно кода
  const centered = (opts.rowAlign ?? 'center') === 'center' && opts.code !== 'none' && known.length >= 4;
  const expectY = anchors.map((x, k) => {
    const y = rowY[k];
    return y === undefined || (centered && Math.abs(y - (x.cy + offset)) > lineH * 0.5) ? x.cy + offset : y;
  });

  // Прочтения второго прохода. Строки полосы и строки таблицы идут в одном порядке,
  // поэтому сопоставляем их выравниванием последовательностей; оставшиеся — по полосе строки.
  const stripReads = anchors.map(() => new Map<Role, string>());
  const stripTotals = new Map<Role, string>();
  for (const role of usedRoles) {
    const lines = stripLines(stripOf(role));
    if (!lines.length) continue;
    const match = alignSequences(expectY, lines.map((l) => l.cy), alignTol);
    match.forEach((li, k) => {
      if (li < 0) return;
      lines[li].used = true;
      stripReads[k].set(role, lines[li].text);
    });
    anchors.forEach((_, k) => {
      if (match[k] >= 0) return;
      const b = numBands[k];
      const cand = lines.filter((l) => !l.used && l.cy > b.top && l.cy <= b.bottom)
        .sort((x, y) => Math.abs(x.cy - expectY[k]) - Math.abs(y.cy - expectY[k]))[0];
      if (cand) { cand.used = true; stripReads[k].set(role, cand.text); }
    });
    // Итог — первая строка полосы ниже последней строки таблицы
    const lastY = Math.max(...lines.filter((l) => l.used).map((l) => l.cy), expectY[expectY.length - 1]);
    const tot = lines.find((l) => !l.used && l.cy > lastY + lineH * 0.5 && l.cy < lastY + lineH * 3.5);
    if (tot) stripTotals.set(role, tot.text);
  }
  // Единицы измерения из второго прохода (фильтр букв «шт», «кг», «блок»…)
  const stripUnits: (string | undefined)[] = anchors.map(() => undefined);
  // берём только целые слова («шт», «кг»): обрывки «к», «т» второй проход выдаёт и для «шт», и для «кг»
  const unitLines = (stripOf('unit')?.lines ?? [])
    .map((l) => ({ cy: (l.y0 + l.y1) / 2, text: l.text.replace(/[^А-Яа-яЁё]/g, ''), used: false }))
    .filter((l) => l.text.length >= 2 && ['шт', 'кг', 'блок', 'бут', 'уп', 'пачка', 'кор', 'л', 'бан'].includes(normalizeUnit(l.text) ?? ''))
    .sort((x, y) => x.cy - y.cy);
  if (unitLines.length) {
    const match = alignSequences(expectY, unitLines.map((l) => l.cy), alignTol);
    match.forEach((li, k) => { if (li >= 0) { unitLines[li].used = true; stripUnits[k] = normalizeUnit(unitLines[li].text); } });
    anchors.forEach((_, k) => {
      if (stripUnits[k]) return;
      const b = numBands[k];
      const cand = unitLines.find((l) => !l.used && l.cy > b.top && l.cy <= b.bottom);
      if (cand) { cand.used = true; stripUnits[k] = normalizeUnit(cand.text); }
    });
  }

  const codeX0 = a.codeCol.x0;
  const nameStrip = stripOf('name');
  const nameStripWords = nameStrip?.lines.length
    ? flattenWords({ ...page, lines: nameStrip.lines }).map((w) => ({ ...w, line: w.line + page.lines.length }))
    : undefined;
  const articleX0 = opts.code !== 'none' && (opts.nameSide ?? 'left') === 'left'
    ? (opts.shortArticles ? findShortArticleColumn(words, anchors, codeX0, lineH) : undefined) ?? findArticleColumn(words, anchors, codeX0, lineH)
    : undefined;
  if (opts.codeWrap) for (const anc of anchors) appendWrappedDigit(anc, words, lineH);
  const numsLeftEdge = cols.length ? Math.min(...cols.filter((_, ci) => roles[ci] !== 'skip').map((c) => c.x0)) : Infinity;
  const numsRightEdge = cols.length ? Math.max(...cols.filter((_, ci) => roles[ci] !== 'skip').map((c) => c.x1)) : Infinity;
  // Левый край столбца наименований: с него начинаются строки «(н/ном:…» (левее — № строки и край соседнего листа)
  const NOM_RE = /^[({]\S{1,3}\/\S{2,4}[:.]/;
  const nomX = opts.barcodeInName ? words.filter((w) => NOM_RE.test(w.text) && w.cy > anchors[0].cy - a.pitch).map((w) => w.x0).sort((p, q) => p - q) : [];
  const nameLeft = nomX.length >= 3 ? nomX[Math.floor(nomX.length * 0.2)] - lineH : -Infinity;

  anchors.forEach((anc, i) => {
    const cells = bandCells[i];
    const numsOf = (role: Role) => {
      const ci = colOf(role);
      if (ci < 0) return [] as number[];
      return [...readValues(rowCols[i][ci]?.num?.num, role), ...readValues(stripReads[i].get(role), role)];
    };

    // Единица измерения: текстовая ячейка перед числами или единица в ячейке количества («12 бут»)
    const nb = nameBand(anchors, i, opts, lineH, numBands[i], a.pitch);
    const bandWords = words.filter((w) => w.cy > nb.top && w.cy <= nb.bottom);
    // слова наименований из отдельного прохода по столбцу (если был)
    const nameSrc = nameStripWords ? nameStripWords.filter((w) => w.cy > nb.top && w.cy <= nb.bottom) : bandWords;
    const inUnitCol = (w: Word) => !!a.unitCol && w.cx > a.unitCol.x0 - lineH * 0.4 && w.cx < a.unitCol.x1 + lineH * 0.4;
    const unitCells = makeCells(words.filter((w) => w.cy > numBands[i].top && w.cy <= numBands[i].bottom && (w.x1 < numsLeftEdge || inUnitCol(w))), cellGap)
      .filter((c) => UNIT_CELL_RE.test(c.text.replace(JUNK_RE, '').trim()) && (opts.code === 'none' || opts.nameSide === 'right' || opts.unitBeforeCode || c.x0 > anc.x1));
    // ближайшая к столбцу количества (у Yupiter правее есть «Штук»: «1 шт.», а единица строки — «бут» в «Общее»)
    const qtyX = cols[colOf('qtyPlan')]?.center ?? cols[colOf('qty')]?.center;
    const unitCell = unitCells.sort((x, y) => (qtyX === undefined ? y.x1 - x.x1 : Math.abs(x.x0 - qtyX) - Math.abs(y.x0 - qtyX)))[0];
    const qtyCell = colOf('qty') >= 0 ? rowCols[i][colOf('qty')] : undefined;
    const planCell = colOf('qtyPlan') >= 0 ? rowCols[i][colOf('qtyPlan')] : undefined;
    // Порядок: единица в самой ячейке количества («5 бут» — сначала «Общее», а не «Штук»: «5 шт.»),
    // чётко прочитанная кириллица, второй проход с фильтром букв, похожие на единицу слова
    const cellUnit = normalizeUnit(planCell?.num?.unit) ?? normalizeUnit(qtyCell?.num?.unit);
    const clean = unitCell?.text.replace(JUNK_RE, '').trim() ?? '';
    const exact = /^(шт|штука|штук|кг|блок|бут|л|уп|упак|пач|пачка|кор|бан|банка)\.?$/i.test(clean) ? normalizeUnit(clean) : undefined;
    const unit = cellUnit ?? exact ?? stripUnits[i] ?? normalizeUnit(unitCell?.text)
      ?? normalizeUnit(cells.find((c) => !c.num && !extractNumbers(c.text).length && /[A-Za-zА-Яа-я]/.test(c.text) && c.x0 > anc.x1 && c.x1 < numsLeftEdge - lineH)?.text);
    const unitWords = new Set(unitCell?.words ?? []);

    // Наименование: слева от кода (З-2), справа от кода (упаковочные листы) или левее чисел (без кодов)
    const half = lineH * 0.2;
    let nameWords: Word[];
    let inName: { code: string; stripCode?: string } | undefined;
    if (opts.barcodeInName) {
      const ordered = bandWords.filter((w) => w.x1 < numsLeftEdge - lineH * 0.3 && w.x0 >= nameLeft).sort((p, q) => p.line - q.line || p.x0 - q.x0);
      const digits = (w: Word) => fixDigits(w.text.replace(/^\W+|\W+$/g, '')).replace(/\D/g, '');
      const isCode = (w: Word) => digits(w).length === 13 && /^\W*[\dOoОоЗзБбlI]{13}\W*$/.test(w.text) && !/^02/.test(digits(w));
      const inline = ordered.filter(isCode).map(digits);
      // столбец «Штрих-код»: 12 цифр и последняя цифра строкой ниже
      const column = ordered.filter((w) => /^\W*\d{12}\W*$/.test(w.text)).map((w) => {
        const col: Anchor = { cy: w.cy, x0: w.x0, x1: w.x1, code: digits(w) };
        appendWrappedDigit(col, words, lineH);
        return col.code;
      }).filter((c) => c.length === 13);
      const reads = [...inline, ...column];
      const best = reads.find((c) => isValidEan(c)) ?? reads[0];
      if (best) inName = { code: best, stripCode: reads.find((c) => c !== best) };
      // наименование — всё до штрихкода, срока годности или «(н/ном:»
      const cut = ordered.findIndex((w) => isCode(w) || NOM_RE.test(w.text) || /^\(?\d{2}[.,]\d{2}[.,]\d{4}\)?$/.test(w.text));
      nameWords = cut >= 0 ? ordered.slice(0, cut) : ordered;
    } else if (opts.code === 'none') {
      nameWords = bandWords.filter((w) => w.x1 < numsLeftEdge - lineH * 0.3 && !unitWords.has(w));
    } else if (opts.nameSide === 'right') {
      nameWords = bandWords.filter((w) => w.x0 > anc.x1 + half && w.x1 < numsLeftEdge - lineH * 0.3 && !unitWords.has(w));
    } else if (opts.nameSide === 'inline') {
      // Всё левее чисел, кроме самого штрихкода; номенклатурный номер «645002 (A)» убирает cleanName
      nameWords = bandWords.filter((w) => w !== anc.word && w.x1 < numsLeftEdge - lineH * 0.3 && !unitWords.has(w)
        && !(UNIT_CELL_RE.test(w.text.replace(JUNK_RE, '').trim()) && w.x0 > anc.x1));
    } else {
      const right = Math.min(anc.x0 + half, articleX0 !== undefined ? articleX0 - lineH * 0.3 : Infinity);
      nameWords = nameSrc.filter((w) => w.x1 <= right && w.x0 < codeX0 && !(opts.unitBeforeCode && unitWords.has(w)));
    }
    const name = cleanName(nameWords, lineH, opts.nameSide === 'inline', i + 1);
    // NTIN из строки («NTIN: 0200132903914» у Евразиан, столбец NTIN у Yupiter): в Sauda часть товаров
    // заведена со штрихкодом, равным NTIN, — по нему каталог найдёт товар точно
    // (неуверенно прочитанный NTIN может совпасть с кодом другого товара — такие не берём)
    const ntins = [...new Set(bandWords.filter((w) => w.conf >= 50).map((w) => fixDigits(w.text).replace(/\D/g, '')).filter((d) => /^0?2\d{11}$/.test(d)))];

    // Весовой товар: «5,23» OCR читает как «523» — добавляем варианты с потерянной запятой
    const weight = unit === 'кг';
    const qtyOf = (role: Role) => {
      const v = numsOf(role);
      return weight ? [
        ...v,
        ...v.filter((x) => Number.isInteger(x) && x >= 100).flatMap((x) => [x / 100, x / 1000]),
        // «4,5» → «45», «3,8» → «38»
        ...v.filter((x) => Number.isInteger(x) && x >= 10 && x < 100 && x % 10 !== 0).map((x) => x / 10),
      ] : v;
    };
    const sol = solveRow({
      qty: [...qtyOf('qtyPlan'), ...qtyOf('qty')],
      qtyPlan: qtyOf('qtyPlan'),
      weight,
      price: numsOf('price'),
      sum: numsOf('sum'),
      vat: numsOf('vat'),
      vatRate: VAT_RATE,
      vatIncluded: true,
    });

    const item: ParsedItem = {
      n: i + 1,
      code: anc.code || undefined,
      // «уп(10 шт)» в отдельном столбце OCR делит на два слова — единица не находится, а «уп(10» уходит в название
      name: stripTrailingQty(name, sol.qty, opts.code === 'none').replace(/\s+[уy][пn]\s*\(\s*10\b.*$/i, ''),
      unit: unit ?? (/[уy][пn]\s*\(\s*10\s*(?:шт|wr|wt|ur)/i.test(wordsToText(bandWords, lineH)) ? 'блок' : undefined),
      qty: sol.qty,
      price: sol.price,
      sum: sol.sum,
      vat: colOf('vat') >= 0 ? sol.vat : undefined,
      issues: [...sol.issues],
      alternatives: sol.alternatives.map(({ qty, price, sum }) => ({ qty, price, sum })),
      readings: { price: numsOf('price'), sum: numsOf('sum'), support: sol.support },
      extraCodes: ntins.length ? ntins : undefined,
      raw: [wordsToText(nameWords, lineH), anc.code, ...cells.map((c) => c.text)].filter(Boolean).join(' | '),
    };
    if (opts.code !== 'none' && (anc.code || anc.stripCode)) applyCode(item, anc, opts);
    else if (opts.code !== 'none') item.issues.push(issue('warn', 'Код строки не прочитан — строка найдена по ценам, введите штрихкод по фото'));
    if (inName) {
      applyCode(item, { cy: anc.cy, x0: anc.x0, x1: anc.x1, ...inName }, { ...opts, code: 'ean' });
      item.unit = 'шт';
    } else if (opts.barcodeInName) item.issues.push(issue('warn', 'Штрихкод в наименовании не прочитан — введите его по фото'));
    // Штрихкод в последнем столбце, правее сумм (Градус компани): строки найдены по суммам, штрихкод берём из строки
    if (opts.barcodeRight) {
      const b = numBands[i];
      const code = words.filter((w) => w.cy > b.top && w.cy <= b.bottom && w.x0 > numsRightEdge)
        // (рамка таблицы «]» после штрихкода читается как лишняя «1» в конце)
        .map((w) => fixDigits(w.text).replace(/\D/g, ''))
        .map((d) => (isValidEan(d) ? d : d.length === 14 && isValidEan(d.slice(0, 13)) ? d.slice(0, 13) : undefined))
        .find((d): d is string => !!d);
      if (code) { item.barcode = code; item.barcodeSource = 'invoice'; }
    }
    // Призовая строка: «Кол-во 0, Приз 6» — товар бесплатный, в «Итого к оплате» не входит
    if (opts.prizeRows) {
      const pi = colOf('price');
      const val = (ci: number) => (ci >= 0 ? readValues(rowCols[i][ci]?.num?.num, 'qty')[0] : undefined);
      const ordered = val(pi - 2), prize = val(pi - 1);
      if (pi >= 2 && ordered === 0 && prize !== undefined && prize > 0) {
        item.qty = prize;
        item.price = 0;
        item.sum = 0;
        item.vat = undefined;
        item.alternatives = [];
        item.issues = [issue('info', `Призовой товар: ${prize} бесплатно`)];
      }
    }
    if (!item.name) item.issues.push(issue('warn', 'Не прочитано наименование', 'noname'));
    doc.items.push(item);
  });

  // Потерянная запятая: «1100000» вместо «11 000,00» в цене и сумме сразу (сверка строки при этом сходится).
  // Если цена ровно в 100 раз больше, чем у остальных строк, а после деления попадает в их диапазон — делим
  const prices = doc.items.map((it) => it.price).filter((p): p is number => p !== undefined && p > 0);
  if (prices.length >= 3) {
    for (const it of doc.items) {
      if (it.price === undefined || it.sum === undefined || !Number.isInteger(it.price) || it.price % 100 !== 0) continue;
      const others = prices.filter((p) => p !== it.price);
      if (others.length < 2) continue;
      const med = median(others);
      const fixed = it.price / 100;
      if (it.price >= med * 50 && fixed >= med * 0.3 && fixed <= med * 3) {
        it.price = fixed;
        it.sum = round2(it.sum / 100);
        it.issues.push(issue('warn', 'Цена и сумма были прочитаны без запятой (в 100 раз больше, чем у соседних строк) — исправлено, сверьте'));
      }
    }
  }

  if (opts.code === 'ean' || opts.barcodeInName) repairByNeighbors(doc.items);

  // Единица не прочитана: дробное количество — кг; иначе единица всей накладной, если она одна,
  // или соседних строк (товары обычно сгруппированы: весовые подряд, штучные подряд)
  const units = new Set(doc.items.map((it) => it.unit).filter(Boolean));
  const read = doc.items.map((it) => it.unit);
  doc.items.forEach((it, i) => {
    if (it.unit) return;
    // (только у надёжно прочитанной строки — дробь из мусорных прочтений не делает товар весовым)
    if (it.qty !== undefined && !Number.isInteger(it.qty) && (it.readings?.support ?? 0) >= 3) { it.unit = 'кг'; return; }
    if (units.size === 1) { it.unit = [...units][0]; return; }
    const prev = read.slice(0, i).reverse().find(Boolean), next = read.slice(i + 1).find(Boolean);
    const guess = prev && next ? (prev === next ? prev : undefined) : prev ?? next;
    if (guess && guess !== 'кг') it.unit = guess;
  });

  // Итоги: строка «Итого» первого прохода и строки полос под таблицей
  const rowsSum = round2(doc.items.reduce((acc, it) => acc + (it.sum ?? 0), 0));
  const rowsVat = round2(doc.items.reduce((acc, it) => acc + (it.vat ?? 0), 0));
  // Слово «Итого» не прочитано — берём строку сразу под таблицей
  const lastBand = numBands[numBands.length - 1];
  const totalsLine = totalsWords ?? words.filter((w) => w.cy > lastBand.bottom && w.cy < lastBand.bottom + lineH * 1.6 && w.x0 > a.numbersLeft);
  const totCells = makeCells(totalsLine, cellGap);
  const totCols = cellsByColumn(totCells, cols, colTol);
  const tol = 0.05 + doc.items.length * 0.01;
  // Строку без слова «Итого» принимаем за итог, только если она сходится со строками
  const trust = (vals: number[], target: number) => (totalsWords ? vals : vals.filter((v) => near(v, target, tol)));
  const totalRead = (role: Role, target: number): number[] => {
    const ci = colOf(role);
    if (ci < 0) return [];
    return [...trust(readValues(totCols[ci]?.num?.num, role), target), ...trust(readValues(stripTotals.get(role), role), target)];
  };
  const sumC = totalRead('sum', rowsSum), vatC = totalRead('vat', rowsVat);
  const qtyC = totalsWords ? [...totalRead('qty', 0), ...totalRead('qtyPlan', 0)] : [];
  // Итог иногда напечатан между столбцами — берём все деньги строки «Итого»
  const looseC = [
    ...trust(totCells.flatMap((c) => extractNumbers(fixDigits(c.text.replace(JUNK_RE, ' '))).filter((t) => t.hasDecimals).map((t) => t.value)), rowsSum),
    // «1442400» — итог без запятой (14 424,00) в любом столбце строки «Итого»: берём, только если сходится со строками
    ...totCells.flatMap((c) => extractNumbers(fixDigits(c.text.replace(JUNK_RE, ' '))).filter((t) => !t.hasDecimals && t.text.length >= 5)
      .map((t) => t.value / 100)).filter((v) => near(v, rowsSum, tol)),
  ];
  if (sumC.length || vatC.length || qtyC.length || looseC.length) {
    // Все числа строки «Итого» (и без запятой: «1442400» = 14 424,00) — кандидаты, если строки не сошлись
    const lineNums = totalsWords ? totCells.flatMap((c) => extractNumbers(fixDigits(c.text.replace(JUNK_RE, ' '))))
      .flatMap((t) => (t.hasDecimals ? [t.value] : [t.value, ...(t.text.length >= 5 ? [t.value / 100] : [])])) : [];
    // НДС итога, прочитанный в своём столбце или где-то в строке «Итого»: 1 989,53 → итог 14 424
    const vatReads = [...vatC, ...lineNums.filter((v) => !Number.isInteger(v))];
    const vatOk = (s: number) => vatReads.some((v) => near(v, round2((s * VAT_RATE) / (1 + VAT_RATE)), 0.05));
    // Итог не может быть сильно меньше суммы строк (382 при строках на 14 404 — мусор OCR)
    const plausible = (s: number) => s >= 1 && s >= rowsSum * 0.5;
    const pool = [...sumC, ...looseC, ...lineNums];
    const sum = [...sumC, ...looseC].find((x) => near(x, rowsSum, tol))
      ?? pool.find((x) => plausible(x) && vatOk(x))
      ?? sumC.find(plausible);
    doc.totals = {
      qty: qtyC[0],
      sum,
      vat: vatC.find((x) => near(x, rowsVat, tol)) ?? vatC[0],
      sumAlt: [...sumC, ...looseC].filter((x) => x !== sum).concat(vatC.map((v) => round2((v * (1 + VAT_RATE)) / VAT_RATE))),
    };
  }
  return doc;
}

/**
 * Столбец артикулов/кодов левее столбца кодов (Прима: «Артикул» перед «Штрихкодом»):
 * его цифры не должны попасть в наименование. Возвращает левый край столбца.
 */
function findArticleColumn(words: Word[], anchors: Anchor[], codeX0: number, lineH: number): number | undefined {
  const y0 = anchors[0].cy - lineH, y1 = anchors[anchors.length - 1].cy + lineH * 3;
  const cands = words.filter((w) => w.cy > y0 && w.cy < y1 && w.x1 < codeX0 && (w.text.match(/\d/g) ?? []).length >= 5 && /^[\W]*[\dA-Za-z-]+[\W]*$/.test(w.text));
  if (!cands.length) return undefined;
  const cl = cluster1d(cands.map((w) => w.x0), lineH * 1.5).filter((c) => c.count >= Math.max(2, anchors.length * 0.3));
  if (!cl.length) return undefined;
  const nearest = cl.reduce((p, q) => (q.center > p.center ? q : p));
  // столбец должен стоять вплотную к кодам, иначе это цифры внутри наименований
  const x1s = cands.filter((w) => w.x0 >= nearest.members[0] && w.x0 <= nearest.members[nearest.members.length - 1]).map((w) => w.x1);
  return median(x1s) > codeX0 - lineH * 4 ? nearest.members[0] : undefined;
}

/**
 * Столбец коротких номенклатурных номеров вплотную левее кодов: «КЗ111», «ЯП104», «0349», «001 (Ж)».
 * Возвращает левый край столбца.
 */
function findShortArticleColumn(words: Word[], anchors: Anchor[], codeX0: number, lineH: number): number | undefined {
  const y0 = anchors[0].cy - lineH, y1 = anchors[anchors.length - 1].cy + lineH * 2.5;
  const cands = words.filter((w) => w.cy > y0 && w.cy < y1 && w.x1 < codeX0 && w.x1 > codeX0 - lineH * 5
    && /^\W*[A-Za-zА-Яа-яЁё]{0,3}\d{2,5}\W*$/.test(w.text) && (w.text.match(/\d/g) ?? []).length >= 2);
  if (!cands.length) return undefined;
  const cl = cluster1d(cands.map((w) => w.x0), lineH * 1.5).filter((c) => c.count >= Math.max(2, anchors.length * 0.4));
  if (!cl.length) return undefined;
  const best = cl.reduce((p, q) => (q.count > p.count ? q : p));
  return best.members[0];
}

/**
 * Штрихкод не прошёл проверку контрольной цифры: у товаров одного производителя в накладной
 * начало штрихкода общее (префикс производителя — 8–9 цифр). Замена одной цифры, дающая верный EAN
 * с началом как у соседней строки, — вероятное прочтение; берём, только если такой вариант один.
 */
function repairByNeighbors(items: ParsedItem[]) {
  const good = items.map((it) => (it.barcode && isValidEan(it.barcode) ? it.barcode : undefined));
  items.forEach((it, i) => {
    if (!it.barcode || isValidEan(it.barcode) || !it.issues.some((x) => x.kind === 'ean')) return;
    // прочтения: сам код и 13 цифр без прилипшего № строки или лишней цифры в конце
    const reads = [...new Set([it.barcode, it.code].filter((c): c is string => !!c)
      .flatMap((c) => (c.length === 13 ? [c] : c.length > 13 && c.length <= 15 ? [c.slice(-13), c.slice(0, 13)] : [])))];
    const others = good.filter((g, k): g is string => !!g && k !== i);
    const cands = new Set<string>();
    for (const r of reads) {
      for (let p = 0; p < 13; p++) {
        for (let d = 0; d <= 9; d++) {
          const c = r.slice(0, p) + d + r.slice(p + 1);
          if (c !== r && isValidEan(c) && others.some((o) => o.slice(0, 8) === c.slice(0, 8))) cands.add(c);
        }
      }
    }
    if (cands.size !== 1) return;
    const fixed = [...cands][0];
    it.issues = it.issues.filter((x) => x.kind !== 'ean');
    it.issues.push(issue('warn', `Штрихкод прочитан как ${it.barcode} — исправлен по контрольной цифре и соседним строкам на ${fixed}, сверьте`));
    it.barcode = fixed;
  });
}

/** Деньги в строке OCR: «631,00», «3 155.00» */
const moneyCount = (text: string) => (fixDigits(text).match(/\d[.,]\d{2}(?!\d)/g) ?? []).length;

/**
 * Строка товара, код которой OCR не прочитал ни в одном проходе. Если у поставщика числа стоят на одной
 * линии с кодом (так у большинства строк), то линия с ценой и суммой между двумя найденными строками —
 * пропущенная строка: добавляем её без кода (штрихкод введут вручную), чтобы числа ниже не съехали.
 */
function fillMissingRows(page: OcrPage, anchors: Anchor[], lineH: number): Anchor[] {
  if (anchors.length < 4) return anchors;
  const lineOf = (a: Anchor) => (a.word ? page.lines[a.word.line] : page.lines.find((l) => Math.abs((l.y0 + l.y1) / 2 - a.cy) < lineH * 0.5));
  const onLine = anchors.filter((a) => { const l = lineOf(a); return !!l && moneyCount(l.text) >= 2; }).length;
  if (onLine < anchors.length * 0.7) return anchors;
  const codeX1 = median(anchors.map((a) => a.x1));
  const pitch = median(anchors.slice(1).map((x, k) => x.cy - anchors[k].cy));
  const extra: Anchor[] = [];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    // промежуток на строку больше обычного; линия — посередине, а не продолжение соседней строки
    // (OCR иногда режет одну строку таблицы на две линии)
    if (b.cy - a.cy < pitch * 1.6) continue;
    for (const l of page.lines) {
      const cy = (l.y0 + l.y1) / 2;
      if (cy < a.cy + pitch * 0.6 || cy > b.cy - pitch * 0.6) continue;
      // деньги правее кодов, на линии нет найденного кода
      const right = l.words.filter((w) => w.x0 > codeX1).map((w) => w.text).join(' ');
      if (moneyCount(right) < 2) continue;
      if (extra.some((x) => Math.abs(x.cy - cy) < lineH * 0.7)) continue;
      extra.push({ cy, x0: a.x0, x1: a.x1, code: '' });
    }
  }
  return extra.length ? [...anchors, ...extra].sort((p, q) => p.cy - q.cy) : anchors;
}

/** Перенесённая последняя цифра штрихкода: одна цифра строкой ниже, под кодом */
function appendWrappedDigit(anc: Anchor, words: Word[], lineH: number) {
  const short = (c?: string) => !!c && c.length === 12 && !isValidEan(c);
  if (!short(anc.code) && !short(anc.stripCode)) return;
  const tail = words
    .filter((w) => /^\W*\d\W*$/.test(w.text) && w.cy > anc.cy + lineH * 0.4 && w.cy < anc.cy + lineH * 2.2
      && w.cx > anc.x0 - lineH * 0.5 && w.cx < anc.x1 + lineH * 0.5)
    .sort((p, q) => p.cy - q.cy)[0];
  if (!tail) return;
  const d = tail.text.replace(/\D/g, '');
  if (short(anc.code)) anc.code += d;
  if (short(anc.stripCode)) anc.stripCode += d;
}

/**
 * Количество («6,000», «12.000 шт») иногда прилипает к концу наименования, когда столбец количества
 * вплотную к названию: убираем его, только если оно совпадает с прочитанным количеством строки.
 */
function stripTrailingQty(name: string, qty: number | undefined, noCodes = false): string {
  // Без столбца кодов единица («Блок») и обрывки соседних ячеек остаются в конце названия
  if (noCodes) name = name.replace(/\s+(?:блок|бут|шт|уп|кор)(?![А-Яа-яA-Za-z])[^А-Яа-яA-Za-z]*$/i, '').replace(/\s+[ШЦЩ|!]$/, '').trim();
  // «Сигареты Rothmans Demi Silver 2» — количество из соседнего столбца (только если равно количеству строки)
  if (noCodes && qty !== undefined) name = name.replace(/\s+(\d{1,3})$/, (all, d) => (Number(d) === qty ? '' : all)).replace(/^[A-Za-z]\s+(?=[А-ЯЁ])/, '');
  if (qty === undefined) return name;
  const m = name.match(/\s+(\d{1,4}[.,]\d{3})(?:\s+[^\s\d]{1,4})?$/);
  return m && m.index !== undefined && Number(m[1].replace(',', '.')) === qty ? name.slice(0, m.index).trim() : name;
}

function cleanName(allWords: Word[], lineH: number, inlineCode = false, rowNo?: number): string {
  // Линии сетки и печати OCR читает как «П О Г ВИ Ш» с низкой уверенностью — такие строки выбрасываем
  const lines = new Map<number, Word[]>();
  for (const w of allWords) lines.set(w.line, [...(lines.get(w.line) ?? []), w]);
  // (строка с уверенно прочитанным словом — не мусор: «PEPSI-COLA Бан …» при общей низкой уверенности)
  const junk = new Set([...lines].filter(([, ws]) => ws.filter((w) => w.conf < 50).length >= ws.length * 0.5
    && !ws.some((w) => w.conf >= 80 && /[A-Za-zА-Яа-яЁё]{3,}/.test(w.text))).map(([li]) => li));
  const nameWords = allWords.filter((w) => !junk.has(w.line) && !(w.conf < 30 && w.text.length <= 3) && !(w.conf < 60 && w.text.length <= 2 && !/\d/.test(w.text)));
  // отрезаем № п/п и мусор в начале строк названия: короткое слово без букв, первое в своей строке
  // (не \W — в JS это «не латиница», под него попадали «Хлеб», «с/к», «Для»; и не «300» в середине названия)
  const mx = median(nameWords.map((x) => x.x0));
  const lineStart = new Map<number, number>();
  for (const w of nameWords) lineStart.set(w.line, Math.min(lineStart.get(w.line) ?? Infinity, w.x0));
  // № строки — и не первым словом, если левее прилип мусор от края листа («‘ot 10 Огурец»)
  const isRowNo = (w: Word) => rowNo !== undefined && w.text.replace(/\D/g, '') === String(rowNo) && /^[^A-Za-zА-Яа-яЁё]{1,4}$/.test(w.text);
  const nameClean = nameWords.filter((w) => !(w.x0 < mx && (isRowNo(w) || (/^[^A-Za-zА-Яа-яЁё]{0,4}$/.test(w.text) && w.x0 <= (lineStart.get(w.line) ?? 0)))));
  let name = wordsToText(nameClean.filter((w) => /[A-Za-zА-Яа-яЁё0-9]/.test(w.text)), lineH)
    // «0.45'24_IM_KAZ» — знак между числами заменяем пробелом, иначе объём склеится с упаковкой («0.4524»)
    .replace(/(\d)[`'’°_~^](\d)/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/[`"'“”„«»°|~^\\]/g, '')
    .replace(/\bNTIN:?\s*[\d\s]*/gi, ' ')
    .replace(/\b\d{10,}\b/g, ' ')
    .replace(/^[\s\-—–.,:;]+/, '')
    // «г» и «в/у» OCR читает латиницей: «70r», «250r/6», «70 rp», «Bly» (марки латиницей не трогаем)
    .replace(/(\d)\s?r(?=[\s/]|$)/g, '$1г')
    .replace(/(^|\s)rp(?=\s|$)/g, '$1гр')
    .replace(/(^|\s)[BbЕe]ly(?=\s|$)/g, '$1в/у')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Строки заголовка таблицы попадают в первую строку — отрезаем
  name = name.replace(/^.*?(Наименование,?\s*(?:характеристика|товара)|по\s+порядку)\s*/i, '')
    .replace(/^\W*Ед\.?\s*изм\.?\W*/i, '').replace(/^\d{1,2}\s+/, '');
  // № строки, слипшийся с названием: «10Водка» (цифры и сразу кириллица)
  name = name.replace(/^\d{1,2}(?=[А-ЯЁа-яё]{3})/, '');
  if (inlineCode) {
    // «… 95г / ШК: 4606779450709 645002 (A)»: номенклатурный номер и подпись штрихкода
    name = name
      .replace(/\s*\b\d{5,7}\s*\(?\s*[AАaа]\s*\)?/g, ' ')
      .replace(/\s*\/?\s*\(?(?<![A-Za-zА-Яа-яЁё])(?:ШК|WK|МК|ШK|UK|WК)(?![A-Za-zА-Яа-яЁё])\s*[:.]?/g, ' ')
      .replace(/[\s/.,:]+$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  return name;
}

/** Выбор кода из двух прочтений и проверка EAN */
function applyCode(item: ParsedItem, anc: Anchor, opts: Z2Options) {
  const reads = [anc.code, anc.stripCode].filter((c): c is string => !!c && codeFits(c, opts));
  if (opts.code !== 'ean') {
    // У кодов поставщика нет контрольной цифры: основное — прочтение первого прохода,
    // второе храним как альтернативу (справочник выберет известный код)
    const fits = (c?: string) => !!c && codeFits(c, opts) && (!opts.codeLength || c.length === opts.codeLength);
    item.code = fits(anc.word ? anc.code : undefined) ? anc.code : (anc.stripCode ?? anc.code);
    const alt = [anc.code, anc.stripCode].find((c) => c && c !== item.code && fits(c));
    if (alt) {
      item.codeAlt = alt;
      item.issues.push(issue('warn', `Код поставщика прочитан двумя способами: ${item.code} или ${alt} — сверьте с накладной`, 'code'));
    }
    return;
  }
  item.barcodeSource = 'invoice';
  const valid = reads.find((c) => isValidEan(c));
  if (valid) {
    item.code = valid;
    item.barcode = valid;
    return;
  }
  const long = reads.find((c) => c.length === 14 && isValidEan(c.slice(0, 13)));
  if (long) {
    item.code = long;
    item.barcode = long.slice(0, 13);
    item.issues.push(issue('warn', `В накладной штрихкод из 14 цифр (${long}) — взяты первые 13, контрольная цифра сходится`));
    return;
  }
  // № строки прилип слева: «54640188534674»
  const glued = reads.find((c) => c.length > 13 && c.length <= 15 && isValidEan(c.slice(-13)));
  if (glued) {
    item.code = glued.slice(-13);
    item.barcode = item.code;
    return;
  }
  const fixed = reads.map((c) => repairEan(c)).find((c): c is string => !!c);
  item.code = anc.code;
  if (fixed) {
    item.barcode = fixed;
    item.issues.push(issue('warn', `Штрихкод прочитан как ${anc.code}, исправлен по контрольной цифре на ${fixed} — сверьте`));
  } else {
    item.barcode = anc.stripCode ?? anc.code;
    item.issues.push(issue('error', 'Штрихкод не прошёл проверку контрольной цифры — исправьте', 'ean'));
  }
}

export function normalizeUnit(t?: string): string | undefined {
  if (!t) return undefined;
  // «уп(10 шт)» — блок сигарет: дальше сработает пересчёт «1 блок = 10 шт»
  if (/[уy][пn]\D{0,3}10\D{0,3}(?:шт|wt|ur|um)/i.test(t)) return 'блок';
  // «бут» с «б», прочитанной как 6: «6yr», «6ут»
  if (/^\W*[6б][yу][tтr]\W*$/i.test(t.trim())) return 'бут';
  const s = t.toLowerCase().replace(/[^a-zа-яё]/g, '');
  if (!s) return undefined;
  // "wr"/"xr" OCR выдаёт и для «кг», и для «шт» — такие не угадываем
  if (/^(wr|xr|w)$/.test(s)) return undefined;
  if (/^(к|кг|kr|kg|к[гr])$/.test(s)) return 'кг';
  // «Штука»: OCR выдаёт «Wryka», «Чтука»
  if (/[тt]ук|^[wшч]r?[yу]к/.test(s)) return 'шт';
  if (/па[чy]|na[чy]|пэч|пач|nauk|пак|печк|точк/.test(s)) return 'пачка';
  if (/^(ш|шт|ил|цл|um|ur|un|шл|wt|шr|шm|ит)/.test(s)) return 'шт';
  if (/^бло?к/.test(s)) return 'блок';
  if (/^л$|^n$/.test(s)) return 'л';
  if (/бут|byt/.test(s)) return 'бут';
  if (/^(кор|kop)/.test(s)) return 'кор';
  if (/уп/.test(s)) return 'уп';
  // остальное — только известные единицы, а не мусор OCR («wv», «тог» из «Итог»)
  return /^(г|гр|мл|м|рул|пар|компл|ящ|бан|банка|флак|пак)$/.test(s) ? s : undefined;
}

/** Латинские буквы, похожие на кириллические (OCR путает «АВ» и «AB») */
const toCyrillic = (s: string) => s.replace(/[ABCEHKMOPTXY]/g, (c) => 'АВСЕНКМОРТХУ'['ABCEHKMOPTXY'.indexOf(c)]);

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма[яй]', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

/** Дата в строке: 29.09.2026 или «29 сентября 2026» */
function findDate(t: string): { date: string; index: number } | undefined {
  const m = t.match(/(\d{2})(?:[.,]|\s(?=\d{2}\s))(\d{2})[.,\s](20\d{2})(?!\d)/);
  if (m && Number(m[3]) >= 2015) return { date: `${m[1]}.${m[2]}.${m[3]}`, index: m.index! };
  const w = t.match(new RegExp(String.raw`(\d{1,2})\s+(${MONTHS.join('|')})[а-я]*\s+(20\d{2})`, 'i'));
  if (w) {
    const mi = MONTHS.findIndex((x) => new RegExp(`^${x}`, 'i').test(w[2]));
    return { date: `${w[1].padStart(2, '0')}.${String(mi + 1).padStart(2, '0')}.${w[3]}`, index: w.index! };
  }
  return undefined;
}

/**
 * Номер и дата, перенесённые в узкой ячейке шапки: «АКЦ6594» / «5», «30.09.20» / «26» (ЭльвиНиПлюс).
 * Продолжение — слово из цифр прямо под началом, в пределах его ширины.
 */
function findWrappedNumberAndDate(page: OcrPage): { number?: string; date?: string } {
  const words = flattenWords(page);
  const lineH = typicalLineHeight(words, page);
  const below = (w: Word, re: RegExp) => words.find((x) => re.test(x.text) && x.cy > w.cy + lineH * 0.5 && x.cy < w.cy + lineH * 2.2
    && x.cx > w.x0 && x.cx < w.x1);
  for (const w of words) {
    const m = w.text.match(/^(\d{2})[.,](\d{2})[.,](20)$/);
    if (!m || w.cy > page.height * 0.45) continue;
    const tail = below(w, /^\d{2}$/);
    if (!tail) continue;
    const date = `${m[1]}.${m[2]}.20${tail.text}`;
    // номер — слово левее даты в той же строке, тоже с переносом
    const left = words.filter((x) => Math.abs(x.cy - w.cy) < lineH * 0.5 && x.x1 < w.x0 && /^[A-Za-zА-Яа-яЁё]{1,4}\d{3,}$/.test(x.text))
      .sort((a, b) => b.x1 - a.x1)[0];
    const numTail = left && below(left, /^\d{1,3}$/);
    return { date, number: left ? left.text + (numTail?.text ?? '') : undefined };
  }
  return {};
}

/** Номер и дата документа */
export function findNumberAndDate(page: OcrPage): { number?: string; date?: string } {
  const wrapped = findWrappedNumberAndDate(page);
  if (wrapped.date) return wrapped;
  const lines = page.lines.map((l) => l.text);
  // «Номер реализации: АВ000103427» / «Внутренний номер: …» (упаковочный лист, в т.ч. вторая страница)
  let number: string | undefined;
  let date: string | undefined;
  for (const t of lines) {
    // OCR коверкает «реализации», поэтому держимся за «Номер … : АВ000103427»
    const m = t.match(/[Нн]омер\S*(?:\s+[^\s\d]+)?[\s:_.—-]+([A-ZА-Я]{2}[\dOО]{8,10})(?![\dA-Za-zА-Яа-я])/);
    if (m && !number) number = toCyrillic(m[1].slice(0, 2)) + m[1].slice(2).replace(/[OО]/g, '0');
    const d = t.match(/^\W*Дата\s+\S+\s*:?\s*(.*)$/i);
    if (d && !date && !/составлен/i.test(t)) date = findDate(fixDigits(d[1]))?.date;
  }
  if (number || date) return { number, date };
  // Заголовок «Накладная … № 94688 от 29 сентября 2026 г.», «Реализация товаров № УТ-532 от …»
  for (const t of lines) {
    if (!/накладн|документ|реализаци/i.test(t)) continue;
    const d = findDate(t) ?? findDate(fixDigits(t));
    if (!d) continue;
    // «№» OCR читает и как «Ne»; буквы номера латиницей («YT-532») — кириллицей, как в накладной
    const no = t.match(/(?:№|\bN[eo°])\s*([A-ZА-Яa-z]{0,3}-?\s?\d[\d-]{2,})/);
    const before = fixDigits(t.slice(0, d.index)).match(/\d[\d-]{2,}/g);
    return { date: d.date, number: no ? toCyrillic(no[1].replace(/\s/g, '')) : before?.[before.length - 1] };
  }
  const top = page.lines.filter((l) => l.y1 < page.height * 0.45);
  for (const l of top) {
    // «от 20.12.2012 года №562» — дата приказа о форме, не документа
    if (/приказ|министр|года|приложение|время|оплатить/i.test(l.text)) continue;
    const t = fixDigits(l.text);
    const d = findDate(t);
    // дата приказа о форме З-2, когда OCR потерял слово «года» рядом с ней
    if (!d || d.date === '20.12.2012') continue;
    const before = t.slice(0, d.index).replace(/[|\]\[]/g, ' ');
    const nums = before.match(/\d[\d-]{2,}/g);
    return { date: d.date, number: nums ? nums[nums.length - 1] : undefined };
  }
  return {};
}
