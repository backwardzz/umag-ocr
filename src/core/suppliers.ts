/**
 * Справочник известных поставщиков и форматов их накладных.
 * Поставщик определяется по БИН (цифры OCR читает надёжнее всего) или по названию.
 * Чтобы добавить нового поставщика с накладной формы З-2 — достаточно новой записи.
 */

export type ParserId = 'z2' | 'setkola';

export interface Z2Options {
  /** Какие коды стоят в столбце «Номенклатурный номер» */
  code: 'ean' | 'digits';
  /** Длина кода поставщика (для code = 'digits'), если известна */
  codeLength?: number;
  /**
   * Куда переносится длинное наименование относительно строки с кодом:
   * 'up' — первая часть названия выше кода (GRAND), 'down' — хвост ниже (Мегаполис).
   */
  nameDir: 'up' | 'down' | 'nearest';
}

export interface SupplierDef {
  id: string;
  name: string;
  bins: string[];
  keywords: RegExp[];
  parser: ParserId;
  z2?: Z2Options;
}

export const SUPPLIERS: SupplierDef[] = [
  {
    id: 'grand-konditer',
    name: 'ТОО "GRAND Кондитер"',
    bins: ['170340019202'],
    keywords: [/GRAND\s*Конд/i, /GRAND/],
    parser: 'z2',
    z2: { code: 'ean', nameDir: 'up' },
  },
  {
    id: 'megapolis',
    name: 'ТОО "ТК "Мегаполис-Казахстан"',
    bins: ['960740000122', '121141020357'],
    keywords: [/Мегапол/i, /МЕГАПОЛ/],
    parser: 'z2',
    z2: { code: 'digits', codeLength: 8, nameDir: 'down' },
  },
  {
    id: 'set-kola',
    name: 'ТОО "Сэт Кола"',
    bins: ['180640007797'],
    keywords: [/С[эеa]т\s*Кола/i, /ВСЕГО\s+ПО\s+СЧЕТУ/i],
    parser: 'setkola',
  },
];

/** Настройки З-2 для неизвестного поставщика */
export const GENERIC_Z2: Z2Options = { code: 'digits', nameDir: 'nearest' };
