/**
 * Сверка строки накладной по арифметике. OCR ошибается в отдельных цифрах,
 * но у каждой строки есть избыточность: кол-во × цена = сумма, НДС = сумма × ставка,
 * иногда два столбца количества. Перебираем варианты и берём самый согласованный.
 */
import { near, round2 } from './numbers';
import { issue, type Issue } from './types';

export interface RowReadings {
  /** Прочитанные количества (например, «подлежит отпуску» и «отпущено») */
  qty: number[];
  /** Варианты прочитанной цены (с разными трактовками запятой) */
  price: number[];
  /** Варианты прочитанной суммы */
  sum: number[];
  /** Варианты прочитанной суммы НДС */
  vat: number[];
  /** Итог с НДС, если НДС начисляется сверху (vatIncluded = false) */
  total?: number[];
  /** Ставка НДС (0.16 с 2026 г., 0.12 раньше) */
  vatRate: number;
  /** НДС включён в сумму (З-2: «Сумма с НДС») или начисляется сверху */
  vatIncluded: boolean;
}

export interface Candidate {
  qty: number;
  price: number;
  sum: number;
  score: number;
  /** Сколько независимых прочтений точно подтверждают вариант */
  support: number;
}

export interface RowSolution {
  qty?: number;
  price?: number;
  sum?: number;
  vat?: number;
  support: number;
  issues: Issue[];
  /** Другие правдоподобные варианты (для сверки с итогом документа) */
  alternatives: Candidate[];
}

const uniq = (a: number[]) => [...new Set(a.filter((x) => Number.isFinite(x) && x > 0).map(round2))];

export function vatOf(sum: number, rate: number, included: boolean) {
  return round2(included ? (sum * rate) / (1 + rate) : sum * rate);
}

/**
 * Отличаются ли числа одной цифрой: замена (3000↔5000, 669↔689),
 * пропуск или лишняя цифра (2780↔52780) — типичные ошибки OCR.
 */
export function oneDigitOff(a: number, b: number): boolean {
  const sa = a.toFixed(2).replace('.', ''), sb = b.toFixed(2).replace('.', '');
  if (sa === sb) return false;
  if (sa.length === sb.length) {
    let diff = 0;
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) diff++;
    return diff === 1;
  }
  const [s, l] = sa.length < sb.length ? [sa, sb] : [sb, sa];
  if (l.length - s.length !== 1) return false;
  for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  return false;
}

/** Допуск суммы: цена в накладной округлена до тиын, при большом количестве набегает */
const sumTol = (qty: number) => Math.max(0.02, qty * 0.005 + 0.01);

export function solveRow(r: RowReadings): RowSolution {
  const qtyC = uniq(r.qty);
  const priceC = uniq(r.price);
  const sumC = uniq(r.sum);
  const vatC = uniq(r.vat);
  const totalC = uniq(r.total ?? []);
  const rates = [r.vatRate, 0.12, 0.16].filter((x, i, a) => a.indexOf(x) === i);

  // Выводим недостающие кандидаты из других прочтений
  const qtyAll = [...qtyC];
  const priceAll = [...priceC];
  const sumAll = [...sumC];
  for (const q of qtyC) for (const p of priceC) sumAll.push(round2(q * p));
  for (const v of vatC) for (const rate of rates) sumAll.push(round2(r.vatIncluded ? (v * (1 + rate)) / rate : v / rate));
  for (const t of totalC) for (const rate of rates) sumAll.push(round2(t / (1 + rate)));
  for (const s of uniq(sumAll)) for (const q of qtyC) priceAll.push(round2(s / q));
  for (const s of uniq(sumAll)) for (const p of priceC) {
    const q = s / p;
    if (Math.abs(q - Math.round(q)) < 0.002 || Math.abs(q * 1000 - Math.round(q * 1000)) < 0.01) qtyAll.push(round2(q));
  }

  const cands: Candidate[] = [];
  for (const q of uniq(qtyAll)) {
    for (const p of uniq(priceAll)) {
      const s = round2(q * p);
      const tol = sumTol(q);
      let score = 0;
      let support = 0;
      const qHits = r.qty.filter((x) => near(x, q, 0.0001)).length;
      if (qHits) { score += 2 + qHits; support++; }
      else if (qtyC.length) score -= 1; // количество прочитано, но не совпало
      if (priceC.some((x) => near(x, p, 0.005))) { score += 3; support++; }
      else if (priceC.some((x) => oneDigitOff(x, p))) score += 1;
      const sRead = sumC.find((x) => near(x, s, tol));
      if (sRead !== undefined) { score += 3; support++; }
      else if (sumC.some((x) => oneDigitOff(x, s))) score += 1;
      const sFinal = sRead ?? s;
      const rateOk = rates.find((rate) => vatC.some((v) => near(v, vatOf(sFinal, rate, r.vatIncluded), 0.03)));
      if (rateOk !== undefined) { score += rateOk === r.vatRate ? 2 : 1; support++; }
      else if (vatC.some((v) => oneDigitOff(v, vatOf(sFinal, r.vatRate, r.vatIncluded)))) score += 1;
      if (!r.vatIncluded && totalC.length) {
        if (rates.some((rate) => totalC.some((t) => near(t, round2(sFinal * (1 + rate)), 0.03 + tol)))) { score += 3; support++; }
        else if (totalC.some((t) => oneDigitOff(t, round2(sFinal * (1 + r.vatRate))))) score += 1;
      }
      if (Number.isInteger(q)) score += 0.5;
      cands.push({ qty: q, price: p, sum: sFinal, score, support });
    }
  }
  cands.sort((a, b) => b.score - a.score);

  const best = cands[0];
  if (!best) {
    return {
      qty: qtyC[0], price: priceC[0], sum: sumC[0], vat: vatC[0], support: 0, alternatives: [],
      issues: [issue('error', 'Не удалось прочитать количество/цену — заполните вручную')],
    };
  }

  const issues: Issue[] = [];
  const vat = vatOf(best.sum, r.vatRate, r.vatIncluded);
  if (best.support <= 1) {
    issues.push(issue('error', 'Числа строки не сходятся — проверьте количество, цену и сумму'));
  } else if (best.support === 2 && sumC.length > 0 && priceC.length > 0) {
    issues.push(issue('warn', 'Часть чисел прочитана с ошибкой, значения восстановлены по арифметике — проверьте'));
  } else {
    const fixed: string[] = [];
    if (r.qty.length && !r.qty.some((x) => near(x, best.qty, 0.0001))) fixed.push('количество');
    if (r.price.length && !r.price.some((x) => near(x, best.price))) fixed.push('цена');
    if (r.sum.length && !r.sum.some((x) => near(x, best.sum, sumTol(best.qty)))) fixed.push('сумма');
    if (fixed.length) issues.push(issue('info', `Исправлено по арифметике: ${fixed.join(', ')}`));
  }
  const alternatives = cands.slice(1).filter((c, i, a) =>
    c.score >= best.score - 6 && !near(c.sum, best.sum) && a.findIndex((x) => near(x.sum, c.sum)) === i).slice(0, 4);
  return { qty: best.qty, price: best.price, sum: best.sum, vat, support: best.support, issues, alternatives };
}
