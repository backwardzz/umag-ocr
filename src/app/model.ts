import { isValidEan, round2, near } from '../core/numbers';
import { itemMapCode, mapKey, supplierKey, type MapEntry, type MappingStore } from '../core/mapping';
import { nameSimilarity, normalizeName, type CatalogIndex } from '../core/catalog';
import { issue, sourceName, type Issue, type ParsedDoc, type ParsedItem } from '../core/types';
import type { UnitRule } from '../core/export';

export type DocStatus = 'queued' | 'processing' | 'done' | 'error';

export interface PagePhoto {
  fileName: string;
  fileUrl: string;
  processedUrl?: string;
}

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
  /** Следующие страницы той же накладной, присоединённые к этой */
  extraPages?: PagePhoto[];
  /** Листы, добавленные кнопкой «Добавить лист» и ещё распознающиеся; итог ждёт их */
  pendingPages?: PendingPage[];
}

export interface PendingPage {
  id: string;
  fileName: string;
  stage?: string;
  progress: number;
}

export const docSupplierKey = (doc: ParsedDoc) => supplierKey(doc.supplierBin, doc.supplier);

const numberDigits = (s?: string) => (s ?? '').replace(/\D/g, '').replace(/^0+/, '');
const rowsSum = (d: ParsedDoc) => round2(d.items.reduce((a, it) => a + (it.sum ?? 0), 0));

/** Все строки накладной b уже есть в a (то же фото или та же страница загружена повторно) */
function containsItems(a: ParsedDoc, b: ParsedDoc): boolean {
  if (!b.items.length) return false;
  const pool = [...a.items];
  return b.items.every((it) => {
    const i = pool.findIndex((x) => near(x.sum, it.sum, 0.05) && near(x.qty, it.qty, 0.001)
      && (it.barcode || it.code ? (x.barcode ?? x.code) === (it.barcode ?? it.code) : nameSimilarity(sourceName(x), sourceName(it)) > 0.6));
    if (i < 0) return false;
    pool.splice(i, 1);
    return true;
  });
}

/**
 * Новая накладная относительно уже загруженных: повтор (то же фото или та же накладная ещё раз)
 * или следующая страница (тот же поставщик и номер, другие строки — упаковочный лист на 2 листах).
 */
export function findRelated(docs: DocEntry[], id: string, doc: ParsedDoc): { kind: 'duplicate' | 'page'; target: DocEntry } | undefined {
  const sk = docSupplierKey(doc);
  const no = numberDigits(doc.number);
  for (const d of docs) {
    if (d.id === id || !d.doc || docSupplierKey(d.doc) !== sk) continue;
    const sameNumber = !!no && numberDigits(d.doc.number) === no;
    // без номера (Карлсберг Пепси) — повтор, если совпали дата, число строк и сумма
    const sameWithoutNumber = !no && !numberDigits(d.doc.number) && d.doc.date === doc.date
      && d.doc.items.length === doc.items.length && near(rowsSum(d.doc), rowsSum(doc), 0.05);
    if ((sameNumber || sameWithoutNumber) && containsItems(d.doc, doc)) return { kind: 'duplicate', target: d };
    if (sameNumber) return { kind: 'page', target: d };
  }
  return undefined;
}

/** Лист b — повтор уже склеенных строк a (то же фото добавили ещё раз) */
export const isSamePage = (a: ParsedDoc, b: ParsedDoc) => containsItems(a, b);

/** Строк на листах; строки удаляли или добавляли вручную — границы листов неизвестны, считаем одним листом */
const pageSizes = (d: ParsedDoc) => (d.pageSizes && d.pageSizes.reduce((x, y) => x + y, 0) === d.items.length ? d.pageSizes : [d.items.length]);

/**
 * Куда встаёт лист b среди листов a (индекс листа): лист без «Итого» — перед последним листом a,
 * если тот уже с «Итого» (листы добавили не по порядку), иначе в конец
 */
export function pageInsertIndex(a: ParsedDoc, b: ParsedDoc): number {
  const n = pageSizes(a).length;
  return a.totals?.sum !== undefined && b.totals?.sum === undefined ? n - 1 : n;
}

/** Лист-продолжение таблицы: без шапки — ни поставщика, ни номера, ни даты */
export const isContinuation = (doc: ParsedDoc) => !!doc.items.length && !doc.supplier && !doc.supplierBin && !doc.number && !doc.date
  // своё «Итого», с которым сходятся строки, — законченная накладная (на последнем листе итог за все листы и с его строками не сходится)
  && !(doc.totals?.sum !== undefined && near(doc.totals.sum, rowsSum(doc), 0.05 + doc.items.length * 0.01));

/**
 * Лист может быть продолжением таблицы накладной: тот же вид таблицы — штрихкоды или коды поставщика в строках
 * есть у обоих или нет у обоих (у «Айс-плюс» штрихкоды в каждой строке, у бланка без кодов их нет — это не её лист)
 */
export function sameTable(a: ParsedDoc, b: ParsedDoc): boolean {
  const coded = (d: ParsedDoc) => d.items.filter((it) => it.code || it.ocrBarcode || (it.barcode && it.barcodeSource === 'invoice')).length / Math.max(1, d.items.length);
  return (coded(a) >= 0.5) === (coded(b) >= 0.5) && a.format === b.format;
}

/** Накладная ждёт следующий лист: итог не найден (он обычно на последнем листе) */
export const awaitsSheet = (d: DocEntry) => !!d.doc && d.doc.totals?.sum === undefined && !isContinuation(d.doc);

/** Присоединяет распознанный лист к накладной: строки и фото встают на место листа */
export function attachPage(d: DocEntry, page: ParsedDoc, ...photo: PagePhoto[]): Partial<DocEntry> {
  if (!d.doc) return {};
  const photos: PagePhoto[] = [{ fileName: d.fileName, fileUrl: d.fileUrl, processedUrl: d.processedUrl }, ...(d.extraPages ?? [])];
  photos.splice(Math.min(pageInsertIndex(d.doc, page), photos.length), 0, ...photo);
  const [main, ...rest] = photos;
  return { doc: mergePages(d.doc, page), fileName: main.fileName, fileUrl: main.fileUrl, processedUrl: main.processedUrl, extraPages: rest };
}

const FORMAT_GUESS =/^Формат накладной не распознан/;

/** Склеивает листы одной накладной; лист с «Итого» (последний) остаётся в конце */
export function mergePages(a: ParsedDoc, b: ParsedDoc): ParsedDoc {
  const at = pageInsertIndex(a, b);
  const sizes = pageSizes(a);
  const cut = sizes.slice(0, at).reduce((x, y) => x + y, 0);
  const items = [...a.items.slice(0, cut), ...b.items, ...a.items.slice(cut)].map((it, i) => ({ ...it, n: i + 1 }));
  const headFirst = at === 0 ? b : a;
  // у листа-продолжения нет шапки — формат «не распознан», хотя у первого листа он известен
  const bIssues = a.issues.some((x) => FORMAT_GUESS.test(x.text)) ? b.issues : b.issues.filter((x) => !FORMAT_GUESS.test(x.text));
  const merged: ParsedDoc = {
    ...a,
    supplier: a.supplier ?? b.supplier,
    supplierBin: a.supplierBin ?? b.supplierBin,
    number: headFirst.number ?? a.number ?? b.number,
    date: headFirst.date ?? a.date ?? b.date,
    items,
    totals: b.totals?.sum !== undefined ? b.totals : a.totals ?? b.totals,
    issues: [...a.issues, ...bIssues].filter((x, i, all) => x.kind !== 'totals' && x.kind !== 'vat-total' && all.findIndex((y) => y.text === x.text) === i),
    pages: (a.pages ?? 1) + (b.pages ?? 1),
    pageSizes: [...sizes.slice(0, at), ...pageSizes(b), ...sizes.slice(at)],
  };
  return fixByTotals(merged);
}

/** Сверка с «Итого» после склейки листов: итог по НДС и количество по итогу количества */
export const fixByTotals = (doc: ParsedDoc) => qtyByTotal(totalByVat(doc));

/**
 * Запятая в количестве потеряна или лишняя: «5 кг × 156,20» вместо «0,5 кг × 1 562» — сумма та же,
 * а «Итого» количества не сходится ровно на эту строку. Исправляем, только если такая строка одна
 */
export function qtyByTotal(doc: ParsedDoc): ParsedDoc {
  const want = doc.totals?.qty;
  if (want === undefined) return doc;
  const have = doc.items.reduce((a, it) => a + ((it.orig ? it.orig.qty : it.qty) ?? 0), 0);
  const diff = want - have;
  // большая разница — это не одна строка, а лист из многостраничной накладной (итог за все листы)
  if (Math.abs(diff) < 0.0005 || Math.abs(diff) > have * 0.5) return doc;
  const k = diff < 0 ? 0.1 : 10;
  // дробное количество бывает только у весового и разливного товара: «0,5 шт» — не прочтение
  const fits = (it: ParsedItem) => {
    const q = Math.round(it.qty! * k * 1000) / 1000;
    return Number.isInteger(q) || /^(кг|л|м|г)(?![а-яё])/i.test(it.unit ?? '');
  };
  let hits = doc.items.flatMap((it, i) => (!it.orig && !it.edited && it.qty && it.price !== undefined && near(it.qty * k - it.qty, diff, 0.0005) && fits(it) ? [i] : []));
  // несколько подходящих строк («5 кг» не одна) — та, где OCR прочитал цену именно такой («1 562»), а она пересчитана арифметикой
  if (hits.length > 1) hits = hits.filter((i) => doc.items[i].readings?.price.some((p) => near(p, doc.items[i].price! / k, 0.01)));
  if (hits.length !== 1) return doc;
  const items = doc.items.map((it, i) => (i !== hits[0] ? it : {
    ...it, qty: Math.round(it.qty! * k * 1000) / 1000, price: round2(it.price! / k),
    issues: [...it.issues, issue('warn', `Количество прочитано как ${it.qty}, по «Итого» количества — ${Math.round(it.qty! * k * 1000) / 1000} (сумма та же) — сверьте`)],
  }));
  return { ...doc, items };
}

/**
 * Итог прочитан с ошибкой (потеряна первая цифра: «36 264» вместо «136 264»), а НДС в «Итого»
 * сходится с суммой строк — итог восстанавливаем по НДС
 */
export function totalByVat(doc: ParsedDoc): ParsedDoc {
  const t = doc.totals;
  if (t?.sum === undefined || t.vat === undefined) return doc;
  const sum = rowsSum(doc);
  if (near(t.sum, sum, 0.05 + doc.items.length * 0.01)) return doc;
  const vatOk = [0.12, 0.16].some((r) => near(t.vat!, round2((sum * r) / (1 + r)), 0.05 + doc.items.length * 0.01));
  if (!vatOk) return doc;
  return {
    ...doc,
    totals: { ...t, sum, sumAlt: [...(t.sumAlt ?? []), t.sum] },
    issues: [...doc.issues, issue('warn', `Итог прочитан как ${money(t.sum)} ₸, но НДС в «Итого» (${money(t.vat)} ₸) сходится с суммой строк ${money(sum)} ₸ — сверьте итог`, 'vat-total')],
  };
}

/** Подставляет штрихкоды из справочника для строк с кодом поставщика (или по названию, если кодов нет) */
export function applyMapping(doc: ParsedDoc, mapping: MappingStore): ParsedDoc {
  const sk = docSupplierKey(doc);
  const byName = Object.entries(mapping).filter(([k]) => k.startsWith(`${sk}::name:`));
  const byCode = Object.entries(mapping).filter(([k]) => k.startsWith(`${sk}::`) && !k.startsWith(`${sk}::name:`))
    .map(([k, v]) => [k.slice(sk.length + 2), v] as const);
  let changed = false;
  const items = doc.items.map((it) => {
    // автозаполнение из каталога справочник (подтверждённое пользователем) перекрывает
    if (it.barcode && it.barcodeSource !== 'catalog') return it;
    if (!it.code) {
      const key = itemMapCode(it);
      if (!key) return it;
      const exact = mapping[mapKey(sk, key)];
      if (exact) {
        changed = true;
        return { ...it, barcode: exact.barcode, barcodeSource: 'mapping' as const, catalogMatch: undefined };
      }
      // OCR читает название каждый раз чуть по-разному — ищем самое похожее из запомненных
      let best: MapEntry | undefined, score = 0;
      for (const [k, v] of byName) {
        const sc = nameSimilarity(sourceName(it), v.name ?? k.split('::name:')[1]);
        if (sc > score) { score = sc; best = v; }
      }
      if (!best || score < 0.72) return it;
      changed = true;
      return {
        ...it, barcode: best.barcode, barcodeSource: 'mapping' as const, catalogMatch: undefined,
        issues: [...it.issues, issue('warn', `Штрихкод из справочника по похожему названию «${best.name ?? ''}» — сверьте`, 'fuzzy')],
      };
    }
    const m = mapping[mapKey(sk, it.code)];
    if (m) {
      changed = true;
      return { ...it, barcode: m.barcode, barcodeSource: 'mapping' as const, catalogMatch: undefined, issues: it.issues.filter((x) => x.kind !== 'code') };
    }
    // Два прохода OCR прочитали код по-разному — известный справочнику вариант верный
    const alt = it.codeAlt ? mapping[mapKey(sk, it.codeAlt)] : undefined;
    if (!alt) {
      // У кодов поставщика нет контрольной цифры, и OCR ошибается в одной цифре («13730» вместо «73730»).
      // Если в справочнике у этого поставщика ровно один код отличается одной цифрой и название похоже — это он
      const code = it.code;
      const close = byCode.filter(([c, v]) => digitDiff(c, code) === 1 && nameSimilarity(sourceName(it), v.name ?? '') >= 0.6);
      if (close.length !== 1) return it;
      const [known, entry] = close[0];
      changed = true;
      return {
        ...it, code: known, codeAlt: code, barcode: entry.barcode, barcodeSource: 'mapping' as const, catalogMatch: undefined,
        issues: [...it.issues.filter((x) => x.kind !== 'code'), issue('warn', `Код прочитан как ${code}, в справочнике есть ${known} с похожим названием — сверьте`, 'fuzzy')],
      };
    }
    changed = true;
    return {
      ...it, code: it.codeAlt, codeAlt: it.code, barcode: alt.barcode, barcodeSource: 'mapping' as const, catalogMatch: undefined,
      issues: it.issues.filter((x) => x.kind !== 'code'),
    };
  });
  return changed ? { ...doc, items } : doc;
}

/** В скольких цифрах различаются два кода одной длины */
const digitDiff = (a: string, b: string) => (a.length === b.length ? [...a].filter((c, i) => c !== b[i]).length : Infinity);

/**
 * Штрихкод из накладной прочитан с ошибкой (OCR путает 5, 6, 8 и 9 в мелком шрифте), и такого
 * штрихкода нет в каталоге Sauda. Кандидаты — товары каталога со штрихкодом, отличающимся от
 * прочтения одной цифрой (если не сходится контрольная цифра), и товар, найденный по названию,
 * если его штрихкод отличается не больше чем в трёх цифрах. Исправляем, только если кандидат один.
 */
export function catalogFix(it: ParsedItem, doc: ParsedDoc, catalog: CatalogIndex): { barcode: string; name: string } | undefined {
  // Верный по контрольной цифре штрихкод, которого нет в каталоге, — скорее новый товар, чем ошибка OCR
  // (у соседних вкусов одной марки штрихкоды отличаются в 1–2 цифрах, подмена была бы хуже пропуска)
  if (!it.barcode || catalog.has(it.barcode) || isValidEan(it.barcode)) return undefined;
  const reads = [...new Set([it.barcode, it.code, it.codeAlt].filter((c): c is string => !!c && /^\d{13}$/.test(c)))];
  if (!reads.length) return undefined;
  const subs = new Set<string>();
  for (const r of reads) {
    if (isValidEan(r)) continue;
    for (let i = 0; i < 13; i++) {
      for (let d = 0; d <= 9; d++) {
        const c = r.slice(0, i) + d + r.slice(i + 1);
        if (c !== r && catalog.has(c)) subs.add(c);
      }
    }
  }
  const m = catalog.match({ name: sourceName(it), unit: it.unit, supplier: doc.supplier, price: it.price });
  const byName = m && m.by === 'name' && m.confidence !== 'low' && reads.some((r) => digitDiff(r, m.item.barcode) <= 3) ? m.item.barcode : undefined;
  const pick = byName && (!subs.size || subs.has(byName)) ? byName : subs.size === 1 ? [...subs][0] : undefined;
  if (!pick) return undefined;
  return { barcode: pick, name: catalog.get(pick)?.name ?? '' };
}

/**
 * Автозаполнение штрихкодов из каталога Sauda для строк, где штрихкода нет ни в накладной,
 * ни в справочнике: по NTIN (точно) или по похожему названию (возможны ошибки).
 * Прежнее автозаполнение пересчитывается — каталог могли заменить или очистить.
 */
export function applyCatalog(doc: ParsedDoc, catalog?: CatalogIndex): ParsedDoc {
  let changed = false;
  const items = doc.items.map((it) => {
    let cur = it;
    if (cur.barcodeSource === 'catalog') {
      // исправленный по каталогу штрихкод возвращаем к прочитанному в накладной
      cur = { ...cur, barcode: cur.ocrBarcode, barcodeSource: cur.ocrBarcode ? 'invoice' : undefined, catalogMatch: undefined, ocrBarcode: undefined };
      changed = true;
    }
    const fix = cur.barcodeSource === 'invoice' && catalog?.size ? catalogFix(cur, doc, catalog) : undefined;
    if (fix) {
      changed = true;
      return { ...cur, ocrBarcode: cur.barcode, barcode: fix.barcode, barcodeSource: 'catalog' as const, catalogMatch: { name: fix.name, by: 'fix' as const } };
    }
    return cur;
  });
  if (!catalog?.size) return changed ? { ...doc, items } : doc;
  // Строки без штрихкода: варианты из каталога для каждой, затем раздаём так, чтобы разные товары накладной
  // не получили один штрихкод (три вкуса одного пива — не один товар): штрихкод достаётся строке, которой он
  // подходит лучше всех, остальные берут свой следующий вариант или остаются пустыми
  const open = items.map((it, i) => ({ i, it })).filter(({ it }) => !it.barcode && it.qty)
    .map(({ i, it }) => ({
      i, key: normalizeName(sourceName(it)),
      opts: catalog.rank({ name: sourceName(it), unit: it.unit, supplier: doc.supplier, price: it.price, codes: [...(it.extraCodes ?? []), ...(it.code ? [it.code] : [])] }),
    }));
  // штрихкоды, уже занятые строками с кодом из накладной или справочника
  const taken = new Map<string, string>();
  for (const it of items) if (it.barcode) taken.set(catalog.get(it.barcode)?.barcode ?? it.barcode, '');
  const pairs = open.flatMap((o) => o.opts.map((m, rank) => ({ o, m, rank }))).sort((a, b) => b.m.score - a.m.score || a.rank - b.rank);
  const done = new Set<number>();
  for (const { o, m } of pairs) {
    if (done.has(o.i)) continue;
    const owner = taken.get(m.item.barcode);
    // одинаковые названия в накладной (бонусная строка того же товара) — один товар
    if (owner !== undefined && owner !== o.key) continue;
    taken.set(m.item.barcode, o.key);
    done.add(o.i);
    changed = true;
    items[o.i] = { ...items[o.i], barcode: m.item.barcode, barcodeSource: 'catalog' as const, catalogMatch: { name: m.item.name, by: m.by } };
  }
  return changed ? { ...doc, items } : doc;
}

/**
 * Название строки ввели или исправили вручную, а штрихкода у неё нет (новая строка, строка без кода):
 * ищем товар в каталоге Sauda по этому названию и подставляем его штрихкод — как автозаполнение
 * при загрузке накладной (строка помечается «автозаполнение», название берётся из каталога).
 * Штрихкод из накладной, справочника или введённый вручную не трогаем. Не нашлось — прежнее
 * автозаполнение снимается: оно было подобрано под другое название.
 */
export function fillBarcodeByName(it: ParsedItem, doc: ParsedDoc, catalog?: CatalogIndex): ParsedItem {
  if (!catalog?.size || !it.name.trim()) return it;
  if (it.barcode && it.barcodeSource !== 'catalog') return it;
  if (it.catalogMatch?.by === 'fix') return it;
  const m = catalog.match({ name: it.name, unit: it.unit, supplier: doc.supplier, codes: [...(it.extraCodes ?? []), ...(it.code ? [it.code] : [])] });
  if (!m) return it.barcode ? { ...it, barcode: undefined, barcodeSource: undefined, catalogMatch: undefined, altBarcode: undefined, catalogBarcode: undefined, approved: undefined } : it;
  return {
    ...it, barcode: m.item.barcode, barcodeSource: 'catalog', catalogMatch: { name: m.item.name, by: m.by }, altBarcode: undefined, approved: undefined,
    // введённое название — как «название из накладной»: по нему шёл поиск; в строке покажется название из каталога
    invoiceName: it.name, nameSource: undefined,
  };
}

/**
 * Названия из каталога Sauda: если штрихкод строки есть в загруженной базе (из накладной,
 * из справочника, подобран по названию или введён вручную), название берём из базы —
 * в файл для Sauda попадёт название как в магазине. Название из накладной сохраняется
 * в invoiceName (по нему идёт поиск). Название, исправленное вручную, не трогаем.
 * Если штрихкода в базе больше нет (каталог очищен, штрихкод изменён) — возвращаем название из накладной.
 * Здесь же штрихкод, записанный у товара Sauda дополнительным («Доп. код»), заменяется основным.
 */
export function applyCatalogNames(doc: ParsedDoc, catalog?: CatalogIndex): ParsedDoc {
  let changed = false;
  const items = doc.items.map((src) => {
    // штрихкод строки, как он пришёл (из накладной, справочника, вручную), — до замены на основной
    const own = src.altBarcode ?? src.barcode;
    const found = own && catalog?.size ? catalog.get(own) : undefined;
    // товар Sauda строки — по нему в файле складываются разные штрихкоды одного товара
    let it = src.catalogBarcode === found?.barcode ? src : { ...src, catalogBarcode: found?.barcode };
    // Штрихкод строки записан у товара дополнительным («Доп. код») — в приёмку идёт основной штрихкод товара
    const barcode = found?.barcode ?? own;
    const altBarcode = found && found.barcode !== own ? own : undefined;
    if (it.barcode !== barcode || it.altBarcode !== altBarcode) it = { ...it, barcode, altBarcode };
    // единица не прочитана в накладной — берём единицу товара в Sauda («литр» там пишут полностью)
    if (!it.unit && found?.unit) it = { ...it, unit: found.unit === 'литр' ? 'л' : found.unit };
    if (it !== src) changed = true;
    if (it.nameSource === 'manual') return it;
    if (found?.name.trim()) {
      if (it.nameSource === 'catalog' && it.name === found.name) return it;
      changed = true;
      return { ...it, name: found.name, invoiceName: it.invoiceName ?? it.name, nameSource: 'catalog' as const };
    }
    if (it.nameSource !== 'catalog') return it;
    changed = true;
    return { ...it, name: it.invoiceName ?? it.name, nameSource: undefined };
  });
  return changed ? { ...doc, items } : doc;
}

/** Справочник → автозаполнение штрихкодов из каталога → названия из каталога */
export function enrichDoc(doc: ParsedDoc, mapping: MappingStore, catalog?: CatalogIndex): ParsedDoc {
  return applyCatalogNames(applyCatalog(applyMapping(doc, mapping), catalog), catalog);
}

/** Проверки, которые зависят от текущих данных (после правок пользователя) */
export function itemProblems(it: ParsedItem, catalog?: CatalogIndex): Issue[] {
  const out: Issue[] = [];
  if (!it.barcode) {
    out.push(issue('error', it.code
      ? `Нет штрихкода для кода поставщика ${it.code} — введите один раз, он запомнится`
      : it.name.trim()
        ? 'Нет штрихкода — введите один раз, для этого товара он запомнится'
        : 'Нет штрихкода — строка не попадёт в файл', 'barcode'));
  } else {
    if (it.barcodeSource === 'catalog' && it.catalogMatch?.by === 'fix') {
      out.push(issue('warn', `В накладной штрихкод прочитан как ${it.ocrBarcode ?? '?'} — такого нет в каталоге Sauda, `
        + `исправлен на похожий штрихкод товара «${it.catalogMatch.name}», сверьте`, 'autofill'));
    } else if (it.barcodeSource === 'catalog' && it.catalogMatch) {
      out.push(issue('warn', `Штрихкод подобран из каталога Sauda ${it.catalogMatch.by === 'code' ? 'по NTIN' : `по названию из накладной «${sourceName(it)}»`}`
        + ' — возможна ошибка, сверьте', 'autofill'));
    }
    if (!/^\d+$/.test(it.barcode)) out.push(issue('error', 'Штрихкод должен состоять только из цифр'));
    // Внутренние штрихкоды магазина (начинаются с 2) бывают без контрольной цифры
    else if ((it.barcode.length === 13 || it.barcode.length === 8) && !isValidEan(it.barcode) && !it.barcode.startsWith('2'))
      out.push(issue('warn', 'Контрольная цифра штрихкода не сходится — проверьте'));
    if (catalog && catalog.size > 0 && !catalog.has(it.barcode))
      out.push(issue('warn', 'Такого штрихкода нет в каталоге Sauda — создайте товар или проверьте штрихкод'));
  }
  if (!it.qty) out.push(issue('error', 'Не указано количество'));
  if (it.price === undefined) out.push(issue('error', 'Не указана цена'));
  return out;
}

export function allIssues(it: ParsedItem, catalog?: CatalogIndex): Issue[] {
  // замечание разбора о контрольной цифре неактуально, если штрихкод заменён (из каталога, справочника, вручную)
  const parsed = (it.edited ? [] : it.barcodeSource === 'invoice' ? it.issues : it.issues.filter((x) => x.kind !== 'ean'))
    // «не прочитано наименование» неактуально, если название есть (например, из каталога Sauda)
    .filter((x) => !(x.kind === 'noname' && it.name.trim()));
  const all = [...itemProblems(it, catalog), ...parsed];
  // строка проверена пользователем — предупреждения сняты (ошибки и «нет штрихкода» остаются)
  return it.approved ? all.filter((x) => x.level !== 'warn') : all;
}

/** Есть ли у строки предупреждения, которые можно снять кнопкой «Проверено» */
export const hasWarnings = (it: ParsedItem, catalog?: CatalogIndex) =>
  !it.approved && allIssues(it, catalog).some((x) => x.level === 'warn');

/** «Проверено» для всех строк с предупреждениями */
export const approveAll = (items: ParsedItem[], catalog?: CatalogIndex): ParsedItem[] =>
  items.map((it) => (hasWarnings(it, catalog) ? { ...it, approved: true } : it));

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
  // отметка «проверено» — не правка: замечания разбора об ошибках остаются
  const onlyApproval = Object.keys(patch).length === 1 && 'approved' in patch;
  const next: ParsedItem = { ...it, ...patch, edited: onlyApproval ? it.edited : true };
  if ('name' in patch) {
    // исправили вручную — больше не заменяем названием из каталога; исходное из накладной сохраняем для поиска
    next.nameSource = 'manual';
    next.invoiceName = it.invoiceName ?? (it.name || undefined);
  }
  if ('qty' in patch || 'price' in patch) {
    if (next.qty !== undefined && next.price !== undefined) next.sum = round2(next.qty * next.price);
    if (next.pack && next.qty !== undefined) next.pack = { ...next.pack, count: round2(next.qty / next.pack.size) };
  }
  if ('barcode' in patch) {
    next.barcodeSource = patch.barcode ? 'manual' : undefined;
    // введён новый штрихкод — прежняя замена «доп. код → основной» к нему не относится
    next.altBarcode = undefined;
    // другой штрихкод — проверку нужно повторить
    if (patch.barcode !== it.barcode && !('approved' in patch)) next.approved = undefined;
    next.catalogMatch = undefined;
    // другой товар — название снова берётся из каталога (applyCatalogNames)
    if (patch.barcode !== it.barcode && next.nameSource === 'manual') next.nameSource = undefined;
  }
  return next;
}

export function newItem(n: number): ParsedItem {
  return { n, name: '', issues: [], edited: true, added: true };
}

/** Единицы для подсказок в полях «Ед. изм» */
export const UNITS = ['шт', 'кг', 'блок', 'пачка', 'уп', 'бут', 'л', 'кор', 'банка'];

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const unitKey = (u?: string) => (u ?? '').trim().toLowerCase().replace(/\.$/, '');

/** Запоминаем, как было в накладной, — один раз, до первой правки */
const withOrig = (it: ParsedItem): ParsedItem => (it.orig ? it : { ...it, orig: { qty: it.qty, unit: it.unit, price: it.price } });

/**
 * Массовые правки строк. Сумма не меняется никогда — это деньги по накладной;
 * пересчёт единиц меняет только количество (1 блок → 10 шт), цена остаётся ценой из накладной.
 */
export type BulkOp =
  | { kind: 'scale'; field: 'qty' | 'price'; factor: number }
  | { kind: 'unit'; unit?: string }
  /**
   * Пересчёт единиц под приёмку Sauda: количество × factor, цена ÷ factor и новая единица
   * (1 блок по 11 618 = 10 шт по 1 161,80). Сумма не меняется.
   */
  | { kind: 'convert'; factor: number; unit: string }
  /** Вернуть количество, единицу и цену как в накладной */
  | { kind: 'restore' };

export function bulkEditItem(it: ParsedItem, op: BulkOp): ParsedItem {
  if (op.kind === 'restore') {
    if (!it.orig) return it;
    const { orig, ...rest } = it;
    return fixPack({ ...rest, qty: orig.qty, unit: orig.unit, price: orig.price });
  }
  if (op.kind === 'unit') return unitKey(op.unit) === unitKey(it.unit) ? it : { ...withOrig(it), unit: op.unit || undefined };
  if (!(op.factor > 0) || op.factor === 1) return it;
  if (op.kind === 'convert') {
    return fixPack({
      ...withOrig(it),
      qty: it.qty === undefined ? undefined : round3(it.qty * op.factor),
      // Sauda принимает цену за единицу: блок стал десятью пачками — цена пачки в 10 раз меньше
      price: it.price === undefined ? undefined : round2(it.price / op.factor),
      unit: op.unit,
    });
  }
  const v = it[op.field];
  if (v === undefined) return it;
  return fixPack({ ...withOrig(it), [op.field]: op.field === 'qty' ? round3(v * op.factor) : round2(v * op.factor) });
}

/** Упаковка «N x M» следует за количеством */
const fixPack = (it: ParsedItem): ParsedItem =>
  (it.pack && it.qty !== undefined ? { ...it, pack: { ...it.pack, count: round2(it.qty / it.pack.size) } } : it);

export function bulkEdit(items: ParsedItem[], rows: Iterable<number>, op: BulkOp): ParsedItem[] {
  const set = new Set(rows);
  return items.map((it, i) => (set.has(i) ? bulkEditItem(it, op) : it));
}

/** Правило пересчёта для единицы строки (без учёта регистра и точки: «Блок», «блок.») */
export function ruleFor(unit: string | undefined, rules: UnitRule[]): UnitRule | undefined {
  const u = unitKey(unit);
  return u ? rules.find((r) => unitKey(r.from) === u && r.factor > 0 && unitKey(r.to) !== u) : undefined;
}

/**
 * Пересчёт единиц при загрузке накладной (сигареты: 1 блок = 10 шт, цена блока ÷ 10). Строки, уже пересчитанные
 * или поправленные вручную, не трогаем — правило можно применять повторно.
 */
export function applyUnitRules(doc: ParsedDoc, rules: UnitRule[]): ParsedDoc {
  let changed = false;
  const items = doc.items.map((it) => {
    const r = it.orig ? undefined : ruleFor(it.unit, rules);
    if (!r || it.qty === undefined) return it;
    changed = true;
    return bulkEditItem(it, { kind: 'convert', factor: r.factor, unit: r.to });
  });
  return changed ? { ...doc, items } : doc;
}

export const money = (x?: number) =>
  x === undefined ? '' : x.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, ' ');

export const qtyFmt = (x?: number) =>
  x === undefined ? '' : x.toLocaleString('ru-RU', { maximumFractionDigits: 3 }).replace(/ /g, ' ');
