/**
 * Каталог товаров UMAG (файл «Товары → Импорт/Экспорт → Экспорт товаров»).
 * Нужен, чтобы:
 *  1) автоматически подставлять штрихкод, если в накладной его нет (по NTIN или по названию);
 *  2) подсказывать штрихкод по названию в выпадающем списке;
 *  3) предупреждать, если штрихкода из накладной нет в UMAG (товар надо создать).
 * Хранится только в браузере пользователя (сайт публичный — в код каталог не встраиваем).
 */
import * as XLSX from 'xlsx';

export interface CatalogItem {
  name: string;
  barcode: string;
  /** Дополнительные штрихкоды и коды (столбцы «Доп. код», «Код НКТ (NTIN)») */
  extra?: string[];
  unit?: string;
  /** Поставщик, как он назван в UMAG */
  supplier?: string;
}

const KEY = 'umag-ocr.catalog.v1';

/** Компактное хранение: 9 тыс. товаров объектами не помещаются в localStorage с запасом */
type Packed = { v: 2; rows: [string, string, string, string, string][] };

export function loadCatalog(): CatalogItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as CatalogItem[] | Packed;
    if (Array.isArray(data)) return data;
    return data.rows.map(([name, barcode, unit, supplier, extra]) => ({
      name, barcode, unit: unit || undefined, supplier: supplier || undefined, extra: extra ? extra.split(';') : undefined,
    }));
  } catch {
    return [];
  }
}

export function saveCatalog(items: CatalogItem[]): boolean {
  try {
    const packed: Packed = { v: 2, rows: items.map((i) => [i.name, i.barcode, i.unit ?? '', i.supplier ?? '', (i.extra ?? []).join(';')]) };
    localStorage.setItem(KEY, JSON.stringify(packed));
    return true;
  } catch {
    return false;
  }
}

const codesOf = (v: unknown) => String(v ?? '').split(/[;,\s]+/).map((c) => c.replace(/\D/g, '')).filter((c) => c.length >= 4);

/**
 * Читает Excel/CSV из UMAG: ищет строку заголовка со столбцами «Название» и «Штрихкод»,
 * необязательные — «Доп. код», «Код НКТ (NTIN)», «Ед. изм», «Поставщик».
 */
export function parseCatalogData(data: ArrayBuffer | Uint8Array): CatalogItem[] {
  const wb = XLSX.read(data, { type: 'array' });
  const out: CatalogItem[] = [];
  for (const sn of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[sn], { header: 1, raw: false });
    let head: string[] | undefined, start = 0;
    for (let r = 0; r < Math.min(rows.length, 20); r++) {
      const row = (rows[r] ?? []).map((c) => String(c ?? '').toLowerCase());
      if (row.some((c) => /назв|наимен/.test(c)) && row.some((c) => /штрих|barcode|баркод/.test(c))) { head = row; start = r + 1; break; }
    }
    if (!head) continue;
    const col = (re: RegExp) => head!.findIndex((c) => re.test(c));
    const nameCol = col(/назв|наимен/), codeCol = col(/штрих|barcode|баркод/);
    const extraCols = [col(/доп.*код/), col(/ntin|нкт/)].filter((c) => c >= 0);
    const unitCol = col(/ед\.?\s*изм|единиц/), supCol = col(/поставщ/);
    for (let r = start; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const name = String(row[nameCol] ?? '').trim();
      // в ячейке может быть несколько штрихкодов через ; или пробел
      const codes = codesOf(row[codeCol]);
      if (!name || !codes.length) continue;
      const extra = [...codes.slice(1), ...extraCols.flatMap((c) => codesOf(row[c]))];
      out.push({
        name,
        barcode: codes[0],
        extra: extra.length ? extra : undefined,
        unit: unitCol >= 0 ? String(row[unitCol] ?? '').trim() || undefined : undefined,
        supplier: supCol >= 0 ? String(row[supCol] ?? '').trim() || undefined : undefined,
      });
    }
  }
  if (!out.length) throw new Error('В файле не найдены столбцы «Название» и «Штрихкод»');
  return out;
}

export async function parseCatalogFile(file: File): Promise<CatalogItem[]> {
  return parseCatalogData(await file.arrayBuffer());
}

// ---- Нечёткий поиск по названию ----

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sh',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i',
};

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[а-яёәғқңөұүһі]/g, (c) => TRANSLIT[c] ?? c)
    .replace(/(\d)[.,](\d)/g, '$1$2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function trigrams(s: string): Set<string> {
  const t = ` ${s} `;
  const set = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
}

const dice = (x: Set<string>, y: Set<string>) => {
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return (2 * inter) / (x.size + y.size);
};

/** Похожесть названий 0…1 (коэффициент Дайса по триграммам) — переживает ошибки OCR в отдельных буквах */
export function nameSimilarity(a: string, b: string): number {
  return dice(trigrams(normalizeName(a)), trigrams(normalizeName(b)));
}

/**
 * Объём и вес из названия: «0.45», «450мл», «1л», «180гр», «0,19кг» → литры / килограммы.
 * Голая дробь перед «*» — объём напитка в литрах («PEPSI Бан 0.45*24»).
 */
export function sizesOf(name: string): number[] {
  const s = name.toLowerCase().replace(/,/g, '.');
  const out: number[] = [];
  // «rp», «r» — так OCR читает «гр», «г»; «038 кг» — потерянная запятая (0,38 кг)
  const re = /(\d+(?:\.\d+)?)\s*(мл|ml|литр|л|l|гр|г|gr|rp|r|g|кг|kg|kr)(?![a-zа-я])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const v = /^0\d+$/.test(m[1]) ? Number(`0.${m[1].slice(1)}`) : Number(m[1]);
    out.push(/^(мл|ml|гр|г|gr|rp|r|g)$/.test(m[2]) ? v / 1000 : v);
  }
  // Голая дробь — объём в литрах или вес в кг: «Efes 0,45 банка», «PEPSI 0.45*24», «Драфт 0,5» (но не «72,5%»)
  const bare = /(?<![\d.])(\d\.\d{1,3})(?![\d.%])/g;
  while ((m = bare.exec(s))) {
    const v = Number(m[1]);
    if (v >= 0.1 && v <= 5) out.push(v);
  }
  return [...new Set(out.map((x) => Math.round(x * 1000) / 1000))];
}

/** Значимые слова названия (без чисел, упаковок и единиц) */
function wordsOf(name: string): Set<string> {
  // слова с цифрами оставляем («7up», «t36»), кроме чисел и размеров («180gr», «045»)
  return new Set(normalizeName(name).split(' ').filter((w) => w.length >= 2 && /[a-z]/.test(w)
    && !/^\d+(gr|g|ml|l|kg|kr|sht|sm|mm|rp|r|t|sht)$/.test(w)
    && !/^(sht|kg|gr|ml|l|g|sm|im|kaz|tz|t|dp|vak|pet|ban|but|zhb|sb|up|pach|vr|dz)$/.test(w)));
}

/** Слова, которые есть у многих товаров, почти ничего не говорят о совпадении */
const WEAK = /^(sigarety|kolbasa|napitok|voda|pivo|mayonez|ketchup|spred|margarin|konfety|shokolad|sok|chipsy|makarony)$/;

/** Похожи ли поставщики: общее значимое слово («Мегаполис», «Искандыров», «НуралыТрансКом») */
export function sameSupplier(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const words = (s: string) => normalizeName(s).split(' ').filter((w) => w.length >= 4 && !/^(too|ooo|ip|tk|filial|kompaniya|torgovaya|kazahstan|sigarety)$/.test(w));
  const x = new Set(words(a));
  return words(b).some((w) => x.has(w));
}

export interface CatalogQuery {
  name: string;
  unit?: string;
  /** Поставщик накладной — товары этого поставщика в каталоге получают преимущество */
  supplier?: string;
  /** NTIN или другой код из накладной, который может совпасть со штрихкодом в UMAG */
  codes?: string[];
}

export interface CatalogMatch {
  item: CatalogItem;
  score: number;
  /** Как найдено: по коду (надёжно) или по похожему названию (возможны ошибки) */
  by: 'code' | 'name';
}

interface Entry { item: CatalogItem; tri: Set<string>; words: Set<string>; sizes: number[] }

export class CatalogIndex {
  private items: Entry[];
  private byBarcode: Map<string, CatalogItem>;

  constructor(items: CatalogItem[]) {
    // «Новый продукт» — заготовки без названия, для поиска по названию бесполезны
    this.items = items.filter((i) => !/^новый продукт/i.test(i.name)).map((item) => ({
      item, tri: trigrams(normalizeName(item.name)), words: wordsOf(item.name), sizes: sizesOf(item.name),
    }));
    this.byBarcode = new Map();
    for (const i of items) for (const c of [i.barcode, ...(i.extra ?? [])]) if (!this.byBarcode.has(c)) this.byBarcode.set(c, i);
  }

  get size() { return this.byBarcode.size; }

  has(barcode: string) { return this.byBarcode.has(barcode); }

  get(barcode: string) { return this.byBarcode.get(barcode); }

  /** Штрихкод по коду из накладной: NTIN «0200132903914» заведён в UMAG как «200132903914» */
  byCode(code: string): CatalogItem | undefined {
    const c = code.replace(/\D/g, '');
    if (c.length < 8) return undefined;
    return this.byBarcode.get(c) ?? this.byBarcode.get(c.replace(/^0+/, '')) ?? this.byBarcode.get(`0${c}`);
  }

  suggest(name: string, limit = 5): { item: CatalogItem; score: number }[] {
    const q = trigrams(normalizeName(name));
    if (q.size < 3) return [];
    const res: { item: CatalogItem; score: number }[] = [];
    for (const { item, tri } of this.items) {
      const score = dice(q, tri);
      if (score > 0.25) res.push({ item, score });
    }
    res.sort((a, b) => b.score - a.score);
    return res.slice(0, limit);
  }

  /** Оценка похожести товара из накладной на товар каталога, 0…1+ */
  private score(q: { tri: Set<string>; words: Set<string>; sizes: number[]; unit?: string; supplier?: string }, e: Entry): number {
    let common = 0, strong = 0;
    for (const w of q.words) if (e.words.has(w)) { common++; if (!WEAK.test(w)) strong++; }
    if (!strong) return 0; // ни одного значимого общего слова — не тот товар
    // Сходство слов и доля слов каталожного названия, найденных в накладной: короткое «сосиски»
    // не должно перевешивать точное «сосиски мусульманские 380гр»
    const wordDice = (2 * common) / (q.words.size + e.words.size);
    const coverage = common / Math.max(1, e.words.size);
    let s = 0.45 * dice(q.tri, e.tri) + 0.3 * wordDice + 0.25 * coverage;
    if (q.sizes.length && e.sizes.length) {
      const same = (x: number, y: number) => Math.abs(x - y) <= Math.max(0.001, y * 0.03);
      // «0,38 кг» OCR читает как «38 кг»: те же цифры с другим порядком — не штрафуем
      const shifted = (x: number, y: number) => [10, 100, 1000].some((k) => same(x, y * k) || same(x * k, y));
      s += q.sizes.some((x) => e.sizes.some((y) => same(x, y))) ? 0.15
        : q.sizes.some((x) => e.sizes.some((y) => shifted(x, y))) ? 0.05 : -0.3;
    }
    const kg = (u?: string) => /^кг|kg/i.test(u ?? '');
    if (q.unit && e.item.unit) s += kg(q.unit) === kg(e.item.unit) ? 0.03 : -0.15;
    if (q.supplier && sameSupplier(q.supplier, e.item.supplier)) s += 0.12;
    return s;
  }

  /**
   * Лучший товар каталога для строки накладной без штрихкода: сначала по кодам (NTIN),
   * затем по названию. По названию возвращаем только уверенное совпадение с отрывом от второго.
   */
  match(query: CatalogQuery): CatalogMatch | undefined {
    for (const c of query.codes ?? []) {
      const item = this.byCode(c);
      if (item) return { item, score: 1, by: 'code' };
    }
    const q = { tri: trigrams(normalizeName(query.name)), words: wordsOf(query.name), sizes: sizesOf(query.name), unit: query.unit, supplier: query.supplier };
    if (q.words.size === 0 || q.tri.size < 4) return undefined;
    let best: Entry | undefined, bestScore = 0, second = 0;
    for (const e of this.items) {
      const sc = this.score(q, e);
      // второй — лучший из товаров с другим штрихкодом (дубли одного товара не мешают)
      if (sc > bestScore) { if (best && best.item.barcode !== e.item.barcode) second = bestScore; bestScore = sc; best = e; }
      else if (sc > second && e.item.barcode !== best?.item.barcode) second = sc;
    }
    if (!best || bestScore < 0.55 || bestScore - second < 0.04) return undefined;
    return { item: best.item, score: bestScore, by: 'name' };
  }
}
