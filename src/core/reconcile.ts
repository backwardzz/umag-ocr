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
  /**
   * Из них — «подлежит отпуску»: обычно равно отпущенному, но при усушке/скидке веса
   * отличается (5,28 → 5,23 кг), поэтому весит меньше столбца «отпущено»
   */
  qtyPlan?: number[];
  /** Весовой товар (кг): дробное количество вероятнее целого (OCR теряет запятую: 5,23 → 523) */
  weight?: boolean;
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
  /** Цена и сумма прочитаны точно (а не выведены) */
  priceSumRead?: boolean;
}

export interface RowSolution {
  qty?: number;
  price?: number;
  sum?: number;
  vat?: number;
  /** Сколько независимых прочтений подтверждают выбранный вариант */
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

/**
 * Прочитанная сумма подходит к q × p: с точностью до тиын или, для дробного количества,
 * округлённая до целых тенге (KDV: 3,8 кг × 1 446 = 5 494,80 → 5 495)
 */
export function sumMatches(s: number, q: number, p: number, tol = sumTol(q)): boolean {
  const exact = q * p;
  if (near(s, round2(exact), tol)) return true;
  return !Number.isInteger(q) && Number.isInteger(s) && s === Math.round(exact);
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
      const plan = r.qtyPlan ?? [];
      const qHits = r.qty.filter((x) => near(x, q, 0.0001)).length;
      const planHits = plan.filter((x) => near(x, q, 0.0001)).length;
      if (qHits > planHits) { score += 2 + qHits; support++; }
      else if (qHits) { score += 1 + qHits * 0.5; support++; }
      else if (qtyC.length) score -= 1; // количество прочитано, но не совпало
      // одну и ту же цену прочитали оба прохода («1 742,00» и «174200» без запятой) — она вероятнее
      const priceReads = r.price.filter((x) => near(x, p, 0.005)).length;
      if (priceReads) { score += 3 + Math.min(1, (priceReads - 1) * 0.5); support++; }
      else if (priceC.some((x) => oneDigitOff(x, p))) score += 1;
      // из нескольких прочтений суммы — ближайшее к q × p (910,01 и 910,00 при 5 × 182)
      const sRead = sumC.filter((x) => sumMatches(x, q, p, tol)).sort((x, y) => Math.abs(x - s) - Math.abs(y - s))[0];
      if (sRead !== undefined) {
        // и сумму: «3 155,00» во втором проходе и «315500» без запятой в первом
        // (только при прочитанной цене — иначе мусор «2» и «2» перевесит настоящую строку)
        const sumReads = priceReads ? r.sum.filter((x) => near(x, sRead, 0.005)).length : 1;
        score += 3 + Math.min(1, (sumReads - 1) * 0.5);
        support++;
        // прочитанные цена и сумма сошлись — сильнее, чем количество и сумма: сумму можно поделить
        // на малое количество (2, 3) почти всегда, а две суммы с копейками совпадают не случайно
        if (priceReads) score += 1;
      } else if (sumC.some((x) => oneDigitOff(x, s))) score += 1;
      // Сумма в накладной — это q × p с округлением до тиын. Прочтение, отличающееся на 1 тиын
      // при точно прочитанной цене, — ошибка OCR (910,01 вместо 910,00)
      const exactPrice = priceC.some((x) => near(x, p, 0.001));
      const sFinal = sRead !== undefined && !(exactPrice && Math.abs(sRead - s) <= 0.011) ? sRead : s;
      const rateOk = rates.find((rate) => vatC.some((v) => near(v, vatOf(sFinal, rate, r.vatIncluded), 0.03)));
      if (rateOk !== undefined) { score += rateOk === r.vatRate ? 2 : 1; support++; }
      else if (vatC.some((v) => oneDigitOff(v, vatOf(sFinal, r.vatRate, r.vatIncluded)))) score += 1;
      if (!r.vatIncluded && totalC.length) {
        if (rates.some((rate) => totalC.some((t) => near(t, round2(sFinal * (1 + rate)), 0.03 + tol)))) { score += 3; support++; }
        else if (totalC.some((t) => oneDigitOff(t, round2(sFinal * (1 + r.vatRate))))) score += 1;
      }
      // целое количество вероятнее — если только в строке не прочитано дробное (вес: 5,23 кг)
      if (Number.isInteger(q) && !r.qty.some((x) => !Number.isInteger(x))) score += 0.5;
      if (r.weight && !Number.isInteger(q)) score += 0.5;
      // «отпущено» обычно равно «подлежит отпуску» или чуть меньше (усушка) — но не в 10 раз
      if (!planHits && plan.some((x) => Math.abs(x - q) <= x * 0.1)) score += 0.5;
      cands.push({ qty: q, price: p, sum: sFinal, score, support, priceSumRead: priceReads > 0 && sRead !== undefined });
    }
  }
  // Сначала — больше независимых подтверждений (кол-во, цена, сумма, НДС), затем баллы:
  // два одинаково неверных прочтения количества не должны перевесить прочитанную цену
  cands.sort((a, b) => b.support - a.support || b.score - a.score);

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
  } else if (best.support === 2 && best.priceSumRead && Number.isInteger(best.qty)) {
    // Количество не прочиталось (галочка поверх, «бут» вместо цифры), но цена и сумма прочитаны
    // точно и делятся нацело — количество надёжно: сумма / цена
    issues.push(issue('info', 'Количество вычислено: сумма / цена'));
  } else if (best.support === 2 && sumC.length > 0 && priceC.length > 0) {
    issues.push(issue('warn', 'Часть чисел прочитана с ошибкой, значения восстановлены по арифметике — проверьте'));
  } else {
    const fixed: string[] = [];
    if (r.qty.length && !r.qty.some((x) => near(x, best.qty, 0.0001))) fixed.push('количество');
    if (r.price.length && !r.price.some((x) => near(x, best.price))) fixed.push('цена');
    if (r.sum.length && !r.sum.some((x) => sumMatches(x, best.qty, best.price))) fixed.push('сумма');
    if (fixed.length) issues.push(issue('info', `Исправлено по арифметике: ${fixed.join(', ')}`));
  }
  const alternatives = cands.slice(1).filter((c, i, a) =>
    c.score >= best.score - 6 && !near(c.sum, best.sum) && a.findIndex((x) => near(x.sum, c.sum)) === i).slice(0, 4);
  return { qty: best.qty, price: best.price, sum: best.sum, vat, support: best.support, issues, alternatives };
}
