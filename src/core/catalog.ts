/**
 * Каталог товаров UMAG (файл «Товары → Импорт/Экспорт → Экспорт товаров»).
 * Нужен, чтобы: 1) подсказывать штрихкод по названию для поставщиков без EAN;
 * 2) предупреждать, если штрихкода из накладной нет в UMAG (товар надо создать).
 */
import * as XLSX from 'xlsx';

export interface CatalogItem {
  name: string;
  barcode: string;
}

const KEY = 'umag-ocr.catalog.v1';

export function loadCatalog(): CatalogItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CatalogItem[]) : [];
  } catch {
    return [];
  }
}

export function saveCatalog(items: CatalogItem[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
    return true;
  } catch {
    return false;
  }
}

/** Читает Excel/CSV из UMAG: ищет строку заголовка со столбцами «Название» и «Штрихкод» */
export async function parseCatalogFile(file: File): Promise<CatalogItem[]> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const out: CatalogItem[] = [];
  for (const sn of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[sn], { header: 1, raw: false });
    let nameCol = -1, codeCol = -1, start = 0;
    for (let r = 0; r < Math.min(rows.length, 20); r++) {
      const row = (rows[r] ?? []).map((c) => String(c ?? '').toLowerCase());
      const n = row.findIndex((c) => /назв|наимен/.test(c));
      const b = row.findIndex((c) => /штрих|barcode|баркод/.test(c));
      if (n >= 0 && b >= 0) { nameCol = n; codeCol = b; start = r + 1; break; }
    }
    if (nameCol < 0) continue;
    for (let r = start; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const name = String(row[nameCol] ?? '').trim();
      // в ячейке может быть несколько штрихкодов через ; или пробел
      const codes = String(row[codeCol] ?? '').split(/[;,\s]+/).map((c) => c.replace(/\D/g, '')).filter((c) => c.length >= 4);
      for (const barcode of codes) if (name) out.push({ name, barcode });
    }
  }
  if (!out.length) throw new Error('В файле не найдены столбцы «Название» и «Штрихкод»');
  return out;
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

export class CatalogIndex {
  private items: { item: CatalogItem; tri: Set<string> }[];
  private byBarcode: Map<string, CatalogItem>;

  constructor(items: CatalogItem[]) {
    this.items = items.map((item) => ({ item, tri: trigrams(normalizeName(item.name)) }));
    this.byBarcode = new Map(items.map((i) => [i.barcode, i]));
  }

  get size() { return this.byBarcode.size; }

  has(barcode: string) { return this.byBarcode.has(barcode); }

  get(barcode: string) { return this.byBarcode.get(barcode); }

  suggest(name: string, limit = 5): { item: CatalogItem; score: number }[] {
    const q = trigrams(normalizeName(name));
    if (q.size < 3) return [];
    const res: { item: CatalogItem; score: number }[] = [];
    for (const { item, tri } of this.items) {
      let inter = 0;
      for (const g of q) if (tri.has(g)) inter++;
      const score = (2 * inter) / (q.size + tri.size);
      if (score > 0.25) res.push({ item, score });
    }
    res.sort((a, b) => b.score - a.score);
    return res.slice(0, limit);
  }
}
