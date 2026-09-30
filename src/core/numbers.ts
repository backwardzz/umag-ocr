/**
 * Разбор чисел из OCR-текста. В казахстанских накладных: пробел — разделитель
 * тысяч, запятая — десятичный разделитель ("1 750,00", "143260,00").
 * OCR часто путает символы, теряет запятую или вставляет лишние знаки.
 */

const DIGIT_LOOKALIKES: Record<string, string> = {
  O: '0', o: '0', О: '0', о: '0', Q: '0', D: '0',
  З: '3', з: '3',
  б: '6', Б: '6',
  l: '1', I: '1', '|': '1', i: '1', ']': '1', '[': '1', '!': '1',
  S: '5', s: '5', $: '5',
  B: '8', В: '8',
  g: '9',
  Ч: '4', ч: '4',
};

/** Исправляет похожие на цифры буквы внутри токена, если токен в основном цифровой */
export function fixDigits(token: string): string {
  const digits = (token.match(/\d/g) ?? []).length;
  if (digits === 0 || digits < token.replace(/[\s.,]/g, '').length * 0.5) return token;
  return token.replace(/[^\d\s.,]/g, (c) => DIGIT_LOOKALIKES[c] ?? c);
}

/** Строго: "1 750,00" / "1750.00" / "1750,00" -> 1750 */
export function parseAmount(s: string): number | undefined {
  const t = s.replace(/[\s ]/g, '').replace(/[‚،]/g, ',');
  const m = t.match(/^(\d+)(?:[.,](\d{1,3}))?$/);
  if (!m) return undefined;
  return Number(m[1] + (m[2] ? '.' + m[2] : ''));
}

export interface NumToken {
  value: number;
  text: string;
  /** Есть ли явная дробная часть (",00") */
  hasDecimals: boolean;
  /** Позиция в строке */
  index: number;
}

/**
 * Находит все числа в строке. Учитывает разделители тысяч пробелом только если
 * число заканчивается дробной частью (иначе "10 10" — это два количества, а не 1010).
 */
export function extractNumbers(line: string): NumToken[] {
  const s = line.replace(/[‚]/g, ',').replace(/(\d)\s*[,.]\s+(\d{2})(?!\d)/g, '$1,$2');
  const out: NumToken[] = [];
  // деньги с разделителями тысяч: 1 750,00 | 143 260,00 | 1750,00
  const re = /(?<![\d,.])(\d{1,3}(?:[  ]\d{3})+[.,]\d{2}|\d+[.,]\d{1,3}|\d+)(?![\d])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const text = m[1];
    const value = parseAmount(text);
    if (value === undefined) continue;
    out.push({ value, text, hasDecimals: /[.,]\d+$/.test(text), index: m.index });
  }
  return out;
}

/** Сумма без потери копеек на float */
export const round2 = (x: number) => Math.round(x * 100 + Number.EPSILON * 100) / 100;

/** Близость двух сумм с абсолютным допуском (по умолчанию 1 тиын) */
export function near(a: number | undefined, b: number | undefined, tol = 0.011): boolean {
  if (a === undefined || b === undefined) return false;
  return Math.abs(a - b) <= tol + 1e-9;
}

/**
 * Если OCR потерял запятую ("175000" вместо "1750,00"), предлагаем варианты
 * интерпретации числа, чтобы сверка по арифметике выбрала правильный.
 */
export function amountVariants(tok: NumToken): number[] {
  const v = [tok.value];
  if (!tok.hasDecimals && tok.text.replace(/\D/g, '').length >= 3) v.push(tok.value / 100);
  return v;
}

/** Проверка контрольной цифры EAN-13 / EAN-8 */
export function isValidEan(code: string): boolean {
  if (!/^\d+$/.test(code) || (code.length !== 13 && code.length !== 8)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  let sum = 0;
  const len = digits.length;
  for (let i = 0; i < len; i++) {
    // Веса 3/1 справа налево
    sum += digits[len - 1 - i] * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * Пытаемся починить EAN-13 с одной ошибкой OCR: перебираем замену одной цифры
 * и возвращаем единственный валидный вариант, если он один (иначе undefined).
 */
export function repairEan(code: string, known?: (c: string) => boolean): string | undefined {
  if (isValidEan(code)) return code;
  if (code.length !== 13) return undefined;
  const found: string[] = [];
  for (let i = 0; i < 13; i++) {
    for (let d = 0; d <= 9; d++) {
      const c = code.slice(0, i) + d + code.slice(i + 1);
      if (c !== code && isValidEan(c) && (!known || known(c))) found.push(c);
    }
  }
  return found.length === 1 ? found[0] : undefined;
}
