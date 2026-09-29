/**
 * Накладная на отпуск запасов на сторону, форма З-2 (приказ МФ РК №562).
 * Стандартные столбцы: 1 №, 2 Наименование, 3 Номенклатурный номер, 4 Ед. изм.,
 * 5 Подлежит отпуску, 6 Отпущено, 7 Цена, 8 Сумма с НДС, 9 Сумма НДС.
 *
 * Алгоритм:
 *  1. Якоря строк — коды в столбце «Номенклатурный номер» (EAN-13 или код поставщика);
 *     оставляем только коды из одного столбца (по x), чтобы отсечь БИН и прочие цифры.
 *  2. Числа справа от кода берём из той же строки OCR (Tesseract ведёт строку по
 *     базовой линии и переживает изгиб листа), запасной вариант — полоса между
 *     соседними кодами. Линии сетки для разбивки строк не используем: лист бывает
 *     согнут, и правая половина таблицы смещена относительно левой.
 *  3. Ячейки раскладываем по столбцам по правому краю (числа выровнены вправо).
 *  4. Если был второй проход по столбцам (page.strips), добавляем его прочтения.
 *  5. Каждую строку сверяем по арифметике (reconcile.ts), итог — с «Итого».
 */
import type { OcrPage, OcrStrip, StripPlan } from '../ocrTypes';
import {
  flattenWords, typicalLineHeight, cluster1d, groupCells, cellText, cellX1, cellCy, wordsToText, median, type Word,
} from '../layout';
import { extractNumbers, fixDigits, isValidEan, repairEan, round2, near, amountVariants } from '../numbers';
import { solveRow } from '../reconcile';
import { issue, type ParsedDoc, type ParsedItem } from '../types';
import type { Z2Options } from '../suppliers';

const VAT_RATE = 0.16;
const ROLE_NAMES = ['qtyPlan', 'qty', 'price', 'sum', 'vat'] as const;
type Role = (typeof ROLE_NAMES)[number];

function cleanCode(text: string): string | undefined {
  // убираем кавычки, апострофы и пр. по краям, но не запятые внутри (это суммы)
  const t = fixDigits(text.replace(/^[^\dA-Za-zА-Яа-я,.]+|[^\dA-Za-zА-Яа-я,.]+$/g, ''));
  return /^\d+$/.test(t) ? t : undefined;
}

function codeFits(code: string, opts: Z2Options): boolean {
  if (opts.code === 'ean') return code.length >= 12 && code.length <= 14;
  if (opts.codeLength) return Math.abs(code.length - opts.codeLength) <= 1;
  return code.length >= 5 && code.length <= 14;
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

function findAnchors(words: Word[], opts: Z2Options, lineH: number): Anchor[] {
  const cands: Anchor[] = [];
  for (const w of words) {
    const code = cleanCode(w.text);
    if (code && codeFits(code, opts)) cands.push({ word: w, code, cy: w.cy, x0: w.x0, x1: w.x1 });
  }
  if (!cands.length) return [];
  // Самый населённый столбец по левому краю
  const cl = cluster1d(cands.map((c) => c.x0), lineH * 2);
  const best = cl.reduce((a, b) => (b.count > a.count ? b : a));
  const lo = best.members[0] - lineH, hi = best.members[best.members.length - 1] + lineH;
  let res = cands.filter((c) => c.x0 >= lo && c.x0 <= hi);
  // Для кодов поставщика — оставляем самую частую длину (±1)
  if (opts.code === 'digits' && !opts.codeLength) {
    const len = median(res.map((c) => c.code.length));
    res = res.filter((c) => Math.abs(c.code.length - len) <= 1);
  }
  res.sort((a, b) => a.cy - b.cy);
  // Дубликаты (одно слово попало в две строки OCR)
  return res.filter((a, i) => i === 0 || Math.abs(a.cy - res[i - 1].cy) > lineH * 0.4);
}

function findTotalsLine(words: Word[], afterY: number, lineH: number): Word[] | undefined {
  const w = words.find((x) => x.cy > afterY && x.cy < afterY + lineH * 4 && /[иИuU][тТt][оoОO][гГr]/.test(x.text));
  if (!w) return undefined;
  return words.filter((x) => Math.abs(x.cy - w.cy) < (w.y1 - w.y0) * 0.8 && x.x0 > w.x0);
}

type Cell = { cell: Word[]; text: string; x0: number; x1: number; cy: number };

/** Общий анализ страницы — нужен и для плана второго прохода, и для разбора */
function analyze(page: OcrPage, opts: Z2Options) {
  const words = flattenWords(page);
  const lineH = typicalLineHeight(words, page);
  const anchors = findAnchors(words, opts, lineH);
  const cellGap = lineH * 0.7;
  const toCells = (ws: Word[]): Cell[] =>
    groupCells(ws, cellGap).map((c) => ({ cell: c, text: fixDigits(cellText(c)), x0: Math.min(...c.map((w) => w.x0)), x1: cellX1(c), cy: cellCy(c) }));
  if (!anchors.length) return { words, lineH, anchors, toCells, cols: [], roles: [] as Role[], bands: [], lineCells: [], bandCells: [], pitch: lineH, totalsWords: undefined };

  const pitch = anchors.length > 1 ? median(anchors.slice(1).map((a, i) => a.cy - anchors[i].cy)) : lineH * 1.5;
  const lastY = anchors[anchors.length - 1].cy;
  const totalsWords = findTotalsLine(words, lastY - lineH, lineH);
  const totalsTop = totalsWords?.length ? Math.min(...totalsWords.map((w) => w.cy)) - lineH * 0.45 : Infinity;

  const bands = anchors.map((a, i) => {
    const prev = anchors[i - 1]?.cy, next = anchors[i + 1]?.cy;
    const top = prev !== undefined ? (prev + a.cy) / 2 : a.cy - pitch * 0.6;
    // У последней строки числа не ниже кода (ниже — уже «Итого»)
    const bottom = next !== undefined ? (next + a.cy) / 2 : Math.min(a.cy + lineH * 0.6, Math.max(a.cy + lineH * 0.3, totalsTop));
    return { top, bottom };
  });

  const lineCells = anchors.map((a) => (a.word ? toCells(words.filter((w) => w.line === a.word!.line && w.x0 > a.x1 + lineH * 0.3)) : []));
  const bandCells = anchors.map((a, i) => {
    const b = bands[i];
    return toCells(words.filter((w) => w.cy > b.top && w.cy <= b.bottom && w.x0 > a.x1 + lineH * 0.3));
  });

  // Столбцы чисел: кластеры правого края числовых ячеек
  const numericCells: Cell[] = [];
  for (const cells of bandCells) for (const c of cells) if (extractNumbers(c.text).length) numericCells.push(c);
  const colTol = lineH * 1.5;
  let cols = cluster1d(numericCells.map((c) => c.x1), colTol).filter((c) => c.count >= Math.max(2, anchors.length * 0.3));
  cols.sort((a, b) => a.center - b.center);
  // Нужны 5 столбцов: подлежит, отпущено, цена, сумма, НДС. Берём 5 самых правых.
  if (cols.length > 5) cols = cols.slice(cols.length - 5);
  const roles = ROLE_NAMES.slice(5 - cols.length) as unknown as Role[];
  // Левые границы столбцов (для полос второго прохода)
  const colsX = cols.map((c) => {
    const members = numericCells.filter((x) => Math.abs(x.x1 - c.center) <= colTol);
    const x0s = members.map((m) => m.x0).sort((a, b) => a - b);
    return { center: c.center, x0: x0s[Math.floor(x0s.length * 0.1)] ?? c.center - lineH * 4, x1: Math.max(...members.map((m) => m.x1)) };
  });
  return { words, lineH, anchors, toCells, cols: colsX, roles, bands, lineCells, bandCells, pitch, totalsWords };
}

/** План второго прохода: полоса кодов и полосы числовых столбцов */
export function planZ2Strips(page: OcrPage, opts: Z2Options): StripPlan[] {
  const a = analyze(page, opts);
  if (a.anchors.length < 2 || a.cols.length < 3) return [];
  const { lineH, anchors, cols } = a;
  const top = anchors[0].cy - a.pitch * 0.7;
  // запас снизу: последняя строка могла не найтись в первом проходе + строка «Итого»
  const bottom = anchors[anchors.length - 1].cy + Math.max(lineH * 4.5, a.pitch * 2.5);
  const plans: StripPlan[] = [];
  const cx0 = median(anchors.map((x) => x.x0)), cx1 = median(anchors.map((x) => x.x1));
  plans.push({ role: 'code', x0: cx0 - lineH, x1: cx1 + lineH, y0: top, y1: bottom, whitelist: '0123456789' });
  cols.forEach((c, i) => {
    const prevRight = i > 0 ? cols[i - 1].x1 : cx1;
    const x0 = Math.max(prevRight + lineH * 0.3, c.x0 - lineH * 1.2);
    const nextLeft = i < cols.length - 1 ? cols[i + 1].x0 : page.width;
    const x1 = Math.min(nextLeft - lineH * 0.3, c.x1 + lineH * 0.8);
    plans.push({ role: a.roles[i], x0, x1, y0: top, y1: bottom, whitelist: '0123456789,. ' });
  });
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

export function parseZ2(page: OcrPage, opts: Z2Options): ParsedDoc {
  const doc: ParsedDoc = { format: 'z2', formatName: 'Накладная З-2', items: [], issues: [] };
  const a = analyze(page, opts);
  const { words, lineH, toCells, cols, roles, bands, lineCells, bandCells, totalsWords } = a;
  const anchors = [...a.anchors];
  const stripOf = (role: string) => page.strips?.find((s) => s.role === role);

  // Коды из второго прохода: уточняют прочтение и добавляют пропущенные строки
  const codeStrip = stripLines(stripOf('code'));
  for (const l of codeStrip) {
    const code = l.text.replace(/\D/g, '');
    if (!codeFits(code, opts)) continue;
    const near1 = anchors.find((x) => Math.abs(x.cy - l.cy) < lineH * 0.6);
    if (near1) near1.stripCode = code;
    else if (anchors.length) {
      const ref = anchors[0];
      anchors.push({ cy: l.cy, x0: ref.x0, x1: ref.x1, code, stripCode: code });
    }
  }
  anchors.sort((x, y) => x.cy - y.cy);
  if (!anchors.length) {
    doc.issues.push(issue('error', 'Не найдены строки товаров (столбец «Номенклатурный номер»)'));
    return doc;
  }
  if (cols.length < 4) doc.issues.push(issue('warn', `Найдено только ${cols.length} столбцов с числами из 5 — часть значений может отсутствовать`));

  const colTol = lineH * 1.5;
  const inColumn = (cells: Cell[], colIdx: number) => {
    const c = cols[colIdx];
    const inCol = cells.filter((x) => Math.abs(x.x1 - c.center) <= colTol && extractNumbers(x.text).length);
    if (!inCol.length) return undefined;
    return inCol.reduce((p, q) => (Math.abs(q.x1 - c.center) < Math.abs(p.x1 - c.center) ? q : p));
  };
  // Индексы якорей первого прохода (у добавленных из полосы своих ячеек нет)
  const firstPassIdx = (anc: Anchor) => a.anchors.indexOf(anc);
  const claimed = new Set<Word>();
  lineCells.forEach((cells) => cols.forEach((_, ci) => inColumn(cells, ci)?.cell.forEach((w) => claimed.add(w))));
  const pickCol = (anc: Anchor, colIdx: number) => {
    const i = firstPassIdx(anc);
    if (i < 0) return undefined;
    const own = inColumn(lineCells[i], colIdx);
    if (own) return own;
    return inColumn(bandCells[i].filter((c) => !c.cell.some((w) => claimed.has(w))), colIdx);
  };

  // Прочтения второго прохода. Строки полосы и строки таблицы идут в одном порядке,
  // поэтому сопоставляем их выравниванием последовательностей с общим смещением
  // столбца (числа бывают чуть выше кода: перенос названия, изгиб листа).
  const stripReads = new Map<Anchor, Map<Role, string>>();
  const stripTotals = new Map<Role, string>();
  const anchorYs = anchors.map((x) => x.cy);
  roles.forEach((role) => {
    const lines = stripLines(stripOf(role));
    if (!lines.length) return;
    const match = alignSequences(anchorYs, lines.map((l) => l.cy), lineH * 0.65);
    match.forEach((li, k) => {
      if (li < 0) return;
      lines[li].used = true;
      if (!stripReads.has(anchors[k])) stripReads.set(anchors[k], new Map());
      stripReads.get(anchors[k])!.set(role, lines[li].text);
    });
    // Итог — первая строка полосы ниже последней сопоставленной
    const lastIdx = Math.max(-1, ...match);
    const lastY = lastIdx >= 0 ? lines[lastIdx].cy : anchorYs[anchorYs.length - 1];
    const tot = lines.find((l, i) => i > lastIdx && l.cy > lastY + lineH * 0.5 && l.cy < lastY + lineH * 3.5);
    if (tot) stripTotals.set(role, tot.text);
  });

  const readValues = (text: string | undefined, role: Role): number[] => {
    if (!text) return [];
    const toks = extractNumbers(text);
    if (!toks.length) return [];
    const t = toks.reduce((x, y) => (y.text.length > x.text.length ? y : x));
    return role.startsWith('qty') ? [t.value] : amountVariants(t);
  };

  const codeX0 = median(anchors.map((x) => x.x0));
  anchors.forEach((anc, i) => {
    const fp = firstPassIdx(anc);
    const cells = fp >= 0 ? bandCells[fp] : [];
    const numsOf = (role: Role) => {
      const ci = roles.indexOf(role);
      if (ci < 0) return [] as number[];
      return [...readValues(pickCol(anc, ci)?.text, role), ...readValues(stripReads.get(anc)?.get(role), role)];
    };

    // Наименование: зона слева от кода. Направление переноса зависит от поставщика.
    const prev = anchors[i - 1]?.cy, next = anchors[i + 1]?.cy;
    const half = lineH * 0.5;
    const nb = opts.nameDir === 'up'
      ? { top: prev !== undefined ? prev + half : anc.cy - lineH * 2.6, bottom: anc.cy + half }
      : opts.nameDir === 'down'
        ? { top: anc.cy - half, bottom: next !== undefined ? next - half : anc.cy + lineH * 1.8 }
        : fp >= 0 ? bands[fp] : { top: anc.cy - half, bottom: anc.cy + half };
    const nameWords = words.filter((w) => w.cy > nb.top && w.cy <= nb.bottom && w.x1 <= anc.x0 + lineH * 0.2 && w.x0 < codeX0);
    // отрезаем № п/п и мусор в начале строк названия
    const mx = median(nameWords.map((x) => x.x0));
    const nameClean = nameWords.filter((w) => !(/^[\W\d_]{0,4}$/.test(w.text) && w.x0 < mx));
    let name = wordsToText(nameClean.filter((w) => /[A-Za-zА-Яа-яЁё0-9]/.test(w.text)), lineH)
      .replace(/[`"'“”„«»°|_~^\\]/g, '')
      .replace(/^[\s\-—–.,:;]+/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    // Строки заголовка таблицы попадают в первую строку — отрезаем
    name = name.replace(/^.*?(Наименование,?\s*характеристика|по\s+порядку)\s*/i, '').replace(/^\d{1,2}\s+/, '');

    // Единица измерения: текстовая ячейка сразу справа от кода
    const unitCell = cells.find((c) => !extractNumbers(c.text).length && /[A-Za-zА-Яа-я]/.test(c.text) && c.x1 < (cols[0]?.center ?? Infinity) - lineH);
    const unit = normalizeUnit(unitCell?.text);

    const sol = solveRow({
      qty: [...numsOf('qtyPlan'), ...numsOf('qty')],
      price: numsOf('price'),
      sum: numsOf('sum'),
      vat: numsOf('vat'),
      vatRate: VAT_RATE,
      vatIncluded: true,
    });

    const item: ParsedItem = {
      n: i + 1,
      code: anc.code,
      name,
      unit,
      qty: sol.qty,
      price: sol.price,
      sum: sol.sum,
      vat: sol.vat,
      issues: [...sol.issues],
      alternatives: sol.alternatives.map(({ qty, price, sum }) => ({ qty, price, sum })),
      raw: [wordsToText(nameWords, lineH), anc.code, ...cells.map((c) => c.text)].join(' | '),
    };
    applyCode(item, anc, opts);
    if (!name) item.issues.push(issue('warn', 'Не прочитано наименование'));
    doc.items.push(item);
  });

  // Итоги: строка «Итого» первого прохода и строки полос под таблицей
  const rowsSum = round2(doc.items.reduce((acc, it) => acc + (it.sum ?? 0), 0));
  const rowsVat = round2(doc.items.reduce((acc, it) => acc + (it.vat ?? 0), 0));
  const totCells = totalsWords ? toCells(totalsWords) : [];
  const totalRead = (role: Role): number[] => {
    const ci = roles.indexOf(role);
    if (ci < 0) return [];
    return [...readValues(inColumn(totCells, ci)?.text, role), ...readValues(stripTotals.get(role), role)];
  };
  const sumC = totalRead('sum'), vatC = totalRead('vat'), qtyC = [...totalRead('qty'), ...totalRead('qtyPlan')];
  if (sumC.length || vatC.length || qtyC.length) {
    const sum = sumC.find((x) => near(x, rowsSum, 0.05 + doc.items.length * 0.01)) ?? sumC.find((x) => x >= 1) ?? sumC[0];
    doc.totals = {
      qty: qtyC[0],
      sum,
      vat: vatC.find((x) => near(x, rowsVat, 0.05 + doc.items.length * 0.01)) ?? vatC[0],
      sumAlt: [...sumC.filter((x) => x !== sum), ...vatC.map((v) => round2((v * (1 + VAT_RATE)) / VAT_RATE))],
    };
  }
  return doc;
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
  const fixed = reads.map((c) => repairEan(c)).find((c): c is string => !!c);
  item.code = anc.code;
  if (fixed) {
    item.barcode = fixed;
    item.issues.push(issue('warn', `Штрихкод прочитан как ${anc.code}, исправлен по контрольной цифре на ${fixed} — сверьте`));
  } else {
    item.barcode = anc.stripCode ?? anc.code;
    item.issues.push(issue('error', 'Штрихкод не прошёл проверку контрольной цифры — исправьте'));
  }
}

export function normalizeUnit(t?: string): string | undefined {
  if (!t) return undefined;
  const s = t.toLowerCase().replace(/[^a-zа-яё]/g, '');
  if (!s) return undefined;
  // "wr"/"xr" OCR выдаёт и для «кг», и для «шт» — такие не угадываем
  if (/^(wr|xr|w)$/.test(s)) return undefined;
  if (/^(к|кг|kr|kg|к[гr])$/.test(s)) return 'кг';
  if (/па[чy]|na[чy]|пэч|пач|nauk|пак|печк|точк/.test(s)) return 'пачка';
  if (/^(ш|шт|ил|цл|um|ur|шл|wt|шr|шm|ит)/.test(s)) return 'шт';
  if (/^л/.test(s)) return 'л';
  if (/бут/.test(s)) return 'бут';
  if (/уп/.test(s)) return 'уп';
  return s.length <= 6 ? s : undefined;
}

/** Номер и дата документа: первая дата в верхней части страницы и число перед ней */
export function findNumberAndDate(page: OcrPage): { number?: string; date?: string } {
  const top = page.lines.filter((l) => l.y1 < page.height * 0.45);
  for (const l of top) {
    // «от 20.12.2012 года №562» — дата приказа о форме, не документа
    if (/приказ|министр|года|приложение/i.test(l.text)) continue;
    const t = fixDigits(l.text);
    const m = t.match(/(\d{2})[.,](\d{2})[.,](20\d{2})/);
    if (!m || Number(m[3]) < 2015) continue;
    const before = t.slice(0, m.index).replace(/[|\]\[]/g, ' ');
    const nums = before.match(/\d[\d-]{2,}/g);
    return { date: `${m[1]}.${m[2]}.${m[3]}`, number: nums ? nums[nums.length - 1] : undefined };
  }
  return {};
}
