/**
 * Справочник «код поставщика → штрихкод UMAG». У многих поставщиков в накладной
 * свои внутренние коды (Мегаполис: 10002269, Сэт Кола: 168014), а UMAG ищет товар
 * по штрихкоду. Один раз вводим штрихкод — дальше он подставляется автоматически.
 * Хранится в браузере (localStorage); можно выгрузить/загрузить файлом.
 */

export interface MapEntry {
  barcode: string;
  /** Название из накладной — для удобного поиска в справочнике */
  name?: string;
  supplier?: string;
  updated: string;
}

export type MappingStore = Record<string, MapEntry>;

const KEY = 'umag-ocr.mapping.v1';

export function supplierKey(supplierBin?: string, supplier?: string): string {
  return supplierBin || supplier || 'unknown';
}

export const mapKey = (supplier: string, code: string) => `${supplier}::${code}`;

export function loadMapping(): MappingStore {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as MappingStore) : {};
  } catch {
    return {};
  }
}

export function saveMapping(m: MappingStore): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
    return true;
  } catch {
    return false;
  }
}

export function exportMappingJson(m: MappingStore): Blob {
  return new Blob([JSON.stringify({ version: 1, mapping: m }, null, 1)], { type: 'application/json' });
}

export function parseMappingJson(text: string): MappingStore {
  const data = JSON.parse(text);
  const m = data?.mapping ?? data;
  if (!m || typeof m !== 'object') throw new Error('Неверный формат файла справочника');
  const out: MappingStore = {};
  for (const [k, v] of Object.entries(m as Record<string, MapEntry>)) {
    if (v && typeof v.barcode === 'string' && k.includes('::')) out[k] = v;
  }
  return out;
}
