import { isValidEan, round2, near } from '../core/numbers';
import { itemMapCode, mapKey, supplierKey, type MapEntry, type MappingStore } from '../core/mapping';
import { nameSimilarity, type CatalogIndex } from '../core/catalog';
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

/** Склеивает страницы одной накладной; страница с «Итого» (последняя) идёт в конец */
export function mergePages(a: ParsedDoc, b: ParsedDoc): ParsedDoc {
  const [first, last] = a.totals?.sum !== undefined && b.totals?.sum === undefined ? [b, a] : [a, b];
  const items = [...first.items, ...last.items].map((it, i) => ({ ...it, n: i + 1 }));
  return {
    ...a,
    supplier: a.supplier ?? b.supplier,
    supplierBin: a.supplierBin ?? b.supplierBin,
    number: first.number ?? last.number,
    date: first.date ?? last.date,
    items,
    totals: last.totals ?? first.totals,
    issues: [...first.issues, ...last.issues].filter((x, i, all) => x.kind !== 'totals' && all.findIndex((y) => y.text === x.text) === i),
    pages: (a.pages ?? 1) + (b.pages ?? 1),
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
 * штрихкода нет в каталоге UMAG. Кандидаты — товары каталога со штрихкодом, отличающимся от
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
 * Автозаполнение штрихкодов из каталога UMAG для строк, где штрихкода нет ни в накладной,
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
    if (cur.barcode || !catalog?.size || !cur.qty) return cur;
    const m = catalog.match({ name: sourceName(cur), unit: cur.unit, supplier: doc.supplier, codes: [...(cur.extraCodes ?? []), ...(cur.code ? [cur.code] : [])] });
    if (!m) return cur;
    changed = true;
    return { ...cur, barcode: m.item.barcode, barcodeSource: 'catalog' as const, catalogMatch: { name: m.item.name, by: m.by } };
  });
  return changed ? { ...doc, items } : doc;
}

/**
 * Названия из каталога UMAG: если штрихкод строки есть в загруженной базе (из накладной,
 * из справочника, подобран по названию или введён вручную), название берём из базы —
 * в файл для UMAG попадёт название как в магазине. Название из накладной сохраняется
 * в invoiceName (по нему идёт поиск). Название, исправленное вручную, не трогаем.
 * Если штрихкода в базе больше нет (каталог очищен, штрихкод изменён) — возвращаем название из накладной.
 */
export function applyCatalogNames(doc: ParsedDoc, catalog?: CatalogIndex): ParsedDoc {
  let changed = false;
  const items = doc.items.map((src) => {
    const found = src.barcode && catalog?.size ? catalog.get(src.barcode) : undefined;
    // товар UMAG строки — по нему в файле складываются разные штрихкоды одного товара
    let it = src.catalogBarcode === found?.barcode ? src : { ...src, catalogBarcode: found?.barcode };
    // единица не прочитана в накладной — берём единицу товара в UMAG («литр» там пишут полностью)
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
      out.push(issue('warn', `В накладной штрихкод прочитан как ${it.ocrBarcode ?? '?'} — такого нет в каталоге UMAG, `
        + `исправлен на похожий штрихкод товара «${it.catalogMatch.name}», сверьте`, 'autofill'));
    } else if (it.barcodeSource === 'catalog' && it.catalogMatch) {
      out.push(issue('warn', `Штрихкод подобран из каталога UMAG ${it.catalogMatch.by === 'code' ? 'по NTIN' : `по названию из накладной «${sourceName(it)}»`}`
        + ' — возможна ошибка, сверьте', 'autofill'));
    }
    if (!/^\d+$/.test(it.barcode)) out.push(issue('error', 'Штрихкод должен состоять только из цифр'));
    // Внутренние штрихкоды магазина (начинаются с 2) бывают без контрольной цифры
    else if ((it.barcode.length === 13 || it.barcode.length === 8) && !isValidEan(it.barcode) && !it.barcode.startsWith('2'))
      out.push(issue('warn', 'Контрольная цифра штрихкода не сходится — проверьте'));
    if (catalog && catalog.size > 0 && !catalog.has(it.barcode))
      out.push(issue('warn', 'Такого штрихкода нет в каталоге UMAG — создайте товар или проверьте штрихкод'));
  }
  if (!it.qty) out.push(issue('error', 'Не указано количество'));
  if (it.price === undefined) out.push(issue('error', 'Не указана цена'));
  return out;
}

export function allIssues(it: ParsedItem, catalog?: CatalogIndex): Issue[] {
  // замечание разбора о контрольной цифре неактуально, если штрихкод заменён (из каталога, справочника, вручную)
  const parsed = (it.edited ? [] : it.barcodeSource === 'invoice' ? it.issues : it.issues.filter((x) => x.kind !== 'ean'))
    // «не прочитано наименование» неактуально, если название есть (например, из каталога UMAG)
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
    // другой штрихкод — проверку нужно повторить
    if (patch.barcode !== it.barcode && !('approved' in patch)) next.approved = undefined;
    next.catalogMatch = undefined;
    // другой товар — название снова берётся из каталога (applyCatalogNames)
    if (patch.barcode !== it.barcode && next.nameSource === 'manual') next.nameSource = undefined;
  }
  return next;
}

export function newItem(n: number): ParsedItem {
  return { n, name: '', issues: [], edited: true };
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
   * Пересчёт единиц под приёмку UMAG: количество × factor, цена ÷ factor и новая единица
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
      // UMAG принимает цену за единицу: блок стал десятью пачками — цена пачки в 10 раз меньше
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
