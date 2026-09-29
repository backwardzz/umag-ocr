/**
 * Накладная дистрибьютора напитков (ТОО «Сэт Кола», формат Coca-Cola):
 *   КОД  НАИМЕНОВАНИЕ  КОЛ-ВО (N X M)  ЦЕНА ЗА УП. (без НДС)  СТОИМОСТЬ БЕЗ НДС  СТАВКА  НДС  ВСЕГО
 *   168014 КОКА КОЛА 600МЛ ПЭТ 1X2  3 X 24  7 793,10  23 379,31  16%  3 740,69  27 120,00
 * Количество — в упаковках (3 упаковки по 24 шт). Для UMAG переводим в штуки
 * и считаем цену за штуку с НДС.
 */
import type { OcrPage } from '../ocrTypes';
import { extractNumbers, fixDigits, round2, near } from '../numbers';
import { solveRow } from '../reconcile';
import { issue, type ParsedDoc, type ParsedItem } from '../types';

const VAT_RATE = 0.16;

// "3 X 24", "2х 12", "1x12", "2% 6" (OCR путает х и %)
const PACK_RE = /(?:^|\s)(\d{1,3})\s*[xXхХ×%*]\s*(\d{1,3})(?=\s|$)/;

export function parseSetKola(page: OcrPage): ParsedDoc {
  const doc: ParsedDoc = { format: 'setkola', formatName: 'Накладная Сэт Кола (Coca-Cola)', items: [], issues: [] };
  let n = 0;
  for (const line of page.lines) {
    const text = line.text.replace(/\s+/g, ' ').trim();
    // Код товара — 6 цифр в начале строки (после возможного мусора)
    const codeM = text.match(/(?:^|[^\d])(\d{6})\s+(?=[A-Za-zА-Яа-яЁё])/);
    if (!codeM || codeM.index === undefined) continue;
    const afterCode = text.slice(codeM.index + codeM[0].length);
    // Упаковку ищем после названия: название может содержать "1X2", "1ЛХ12", поэтому
    // берём ПЕРВОЕ совпадение, за которым следуют денежные суммы
    const rest = afterCode;
    let packM: RegExpMatchArray | null = null;
    let packIdx = -1;
    const re = new RegExp(PACK_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest))) {
      const tail = rest.slice(m.index + m[0].length);
      const nums = extractNumbers(fixDigits(tail));
      // сразу за упаковкой должна идти цена (с копейками), иначе это часть названия ("1X2")
      if (nums.length && nums[0].hasDecimals && nums.filter((t) => t.hasDecimals).length >= 3) { packM = m; packIdx = m.index; break; }
      re.lastIndex = m.index + 1;
    }
    if (!packM) continue;
    const name = rest.slice(0, packIdx).replace(/[`"'“”„«»°|_~^\\]/g, '').replace(/\s{2,}/g, ' ').trim();
    const tail = fixDigits(rest.slice(packIdx + packM[0].length));
    const rateM = tail.match(/(\d{1,2})\s*%/);
    const rate = rateM ? Number(rateM[1]) / 100 : VAT_RATE;
    const nums = extractNumbers(tail.replace(/(\d{1,2})\s*%/, ' '));
    const money = nums.filter((t) => t.hasDecimals).map((t) => t.value);
    // ожидаем: цена за уп., стоимость без НДС, НДС, всего
    const [pricePack, net, vat, total] = money.length >= 4 ? money.slice(-4) : [money[0], money[1], undefined, money[2]];
    const packs = Number(packM[1]);
    const size = Number(packM[2]);

    const sol = solveRow({
      qty: [packs],
      price: pricePack !== undefined ? [pricePack] : [],
      sum: net !== undefined ? [net] : [],
      vat: vat !== undefined ? [vat] : [],
      total: total !== undefined ? [total] : [],
      vatRate: rate,
      vatIncluded: false,
    });
    const netSum = sol.sum;
    const vatSum = netSum !== undefined ? (vat !== undefined && near(vat, round2(netSum * rate), 0.03) ? vat : round2(netSum * rate)) : undefined;
    const computed = netSum !== undefined && vatSum !== undefined ? round2(netSum + vatSum) : undefined;
    // Прочитанный итог строки точнее пересчёта (цена за упаковку округлена)
    const gross = total !== undefined && (computed === undefined || near(total, computed, 0.05)) ? total : computed;
    const qtyPcs = (sol.qty ?? packs) * size;
    n++;
    const item: ParsedItem = {
      n,
      code: codeM[1],
      name,
      unit: 'шт',
      pack: { count: sol.qty ?? packs, size },
      qty: qtyPcs,
      sum: gross,
      vat: vatSum,
      price: gross !== undefined && qtyPcs ? round2(gross / qtyPcs) : undefined,
      issues: [...sol.issues],
      raw: text,
    };
    if (total !== undefined && gross !== undefined && !near(total, gross, 0.03)) {
      item.issues.push(issue('info', `Итог строки исправлен: ${total} → ${gross}`));
    }
    doc.items.push(item);
  }

  // ВСЕГО ПО СЧЕТУ / НАКЛАДНОЙ : 84 301,72 13 488,28 97 790,00
  const totLine = page.lines.find((l) => /ВСЕГО\s+ПО\s+СЧ/i.test(l.text));
  if (totLine) {
    const money = extractNumbers(fixDigits(totLine.text)).filter((t) => t.hasDecimals).map((t) => t.value);
    if (money.length >= 3) {
      const [net, vat, gross] = money.slice(-3);
      // Итог = без НДС + НДС; если OCR ошибся в одном из чисел, пригодится второй вариант
      doc.totals = { sum: gross, vat, sumAlt: [round2(net + vat)] };
    } else if (money.length) doc.totals = { sum: money[money.length - 1] };
  }

  // Номер и дата: "НАКЛАДНАЯ № 0637972 ОТ 25.07.2026"
  const head = page.lines.find((l) => /НАКЛАДНАЯ/i.test(l.text) && /\d{2}[.,]\d{2}[.,]\d{4}/.test(l.text));
  if (head) {
    const t = fixDigits(head.text);
    doc.number = t.match(/№\s*(\d+)/)?.[1] ?? t.match(/(\d{5,})/)?.[1];
    const d = t.match(/(\d{2})[.,](\d{2})[.,](\d{4})/);
    if (d) doc.date = `${d[1]}.${d[2]}.${d[3]}`;
  }
  return doc;
}
