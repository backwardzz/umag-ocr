/**
 * Заказ торгового представителя («Накладная № ___ от 13.10.2026 · Кому: Шалкар · ТП: … · ЗАКАЗ (d0_76675)»):
 *   №  Код  Наименование  ЕИ  Кол-во  Цена  Сумма
 * Штрихкод не влезает в узкий столбец «Код» и переносится: «468023293» в первой строке товара,
 * «1257» — во второй, рядом с № строки. Наименование тоже в две строки, числа — во второй:
 *   468023293 Чипсы рифленые со вкусом Краба LIT ENERGY
 *   1 1257    120гр                         Штук   10   810   8100
 * Суммы без копеек, «Итог … 48,600 тенге» — запятая разделяет тысячи.
 */
import type { OcrPage } from '../ocrTypes';
import { isValidEan, near } from '../numbers';
import { issue, type ParsedDoc, type ParsedItem } from '../types';

/** «Штук  10  810  8100» — единица и три целых числа в конце строки */
const ROW_TAIL = /\s(Штук\w*|шт\.?|упак\w*|кг|блок\w*|бут\w*)\s+(\d{1,5})\s+(\d[\d ,]*?)\s+(\d[\d ,]*?)\s*$/i;
/** «48,600» — запятая или пробел между тысячами (копеек в этом бланке нет) */
const whole = (s: string) => Number(s.replace(/[ ,]/g, ''));

export function parseTpOrder(page: OcrPage): ParsedDoc {
  const doc: ParsedDoc = { format: 'tporder', formatName: 'Заказ торгового представителя', items: [], issues: [] };
  const lines = page.lines.map((l) => l.text.replace(/[`‚'’|]/g, ' ').replace(/\s+/g, ' ').trim());
  const head = lines.findIndex((t) => /Наименование/i.test(t) && /Кол/i.test(t));
  const end = lines.findIndex((t, i) => i > head && /^Итог/i.test(t));
  const header = lines.slice(0, Math.max(0, head)).join(' ');
  doc.date = header.match(/от\s+(\d{2}\.\d{2}\.\d{4})/)?.[1];
  // номер накладной в бланке пустой — номер заказа «d0_76675»
  doc.number = header.match(/\bd0_(\d+)/i)?.[1] ?? header.match(/Накладная\s*№\s*(\d+)/i)?.[1];
  let pending: string[] = [];
  for (let i = head + 1; i < (end < 0 ? lines.length : end); i++) {
    const t = lines[i];
    const tail = t.match(ROW_TAIL);
    if (!tail || tail.index === undefined) { pending.push(t); continue; }
    // вторая строка товара: «1 1257 120гр» или «6 120гр» (у товара нет штрихкода)
    const lead = t.slice(0, tail.index).match(/^(\d{1,3})\s+(?:(\d{3,6})\s+)?(.*)$/);
    const top = pending.join(' ');
    pending = [];
    const head1 = top.match(/^(\d{6,12})\s+(.*)$/);
    const codeA = head1?.[1] ?? '';
    const codeB = lead?.[2] ?? '';
    const name = [head1 ? head1[2] : top, lead ? lead[3] : t.slice(0, tail.index)].join(' ').replace(/\s+/g, ' ').trim();
    const qty = Number(tail[2]), price = whole(tail[3]), sum = whole(tail[4]);
    const it: ParsedItem = { n: doc.items.length + 1, name, unit: /^Штук/i.test(tail[1]) ? 'шт' : tail[1].toLowerCase(), qty, price, sum, issues: [], raw: `${top} / ${t}` };
    const code = codeA + codeB;
    if (code) {
      it.code = code;
      if ((code.length === 13 || code.length === 8) && isValidEan(code)) { it.barcode = code; it.barcodeSource = 'invoice'; }
      else it.issues.push(issue('warn', `Штрихкод прочитан как ${code} — не прошёл проверку, сверьте`, 'code'));
    }
    if (!near(qty * price, sum, 0.5)) it.issues.push(issue('warn', `${qty} × ${price} ≠ ${sum} — сверьте количество и цену`));
    doc.items.push(it);
  }
  if (end >= 0) {
    const tot = lines[end].match(/(\d+)\s+.*?(\d{1,3}(?:[ ,]\d{3})+|\d{4,})\s*(?:тенге|тг)?[\W_]*$/i);
    if (tot) doc.totals = { qty: Number(tot[1]), sum: whole(tot[2]) };
  }
  // Поставщика в бланке нет — только торговый представитель; марка — в наименованиях
  if (doc.items.some((it) => /LIT\s*ENERGY/i.test(it.name))) doc.supplier = 'LIT ENERGY';
  return doc;
}
