export type IssueLevel = 'error' | 'warn' | 'info';

export interface Issue {
  level: IssueLevel;
  text: string;
  /** Тип замечания (например, 'totals' — сверка итога, пересчитывается в интерфейсе) */
  kind?: string;
}

export interface ParsedItem {
  /** Порядковый номер в накладной */
  n: number;
  /** Код поставщика или штрихкод, как напечатан в накладной */
  code?: string;
  /** Альтернативное прочтение кода поставщика (если два прохода OCR разошлись) */
  codeAlt?: string;
  /** Штрихкод для UMAG (из накладной, если это EAN, или из справочника) */
  barcode?: string;
  /** Откуда взят штрихкод */
  barcodeSource?: 'invoice' | 'mapping' | 'manual';
  /** Строку правили вручную — замечания OCR к ней больше не актуальны */
  edited?: boolean;
  name: string;
  unit?: string;
  /** Количество в единицах учёта (шт/кг/пачка/бутылка) */
  qty?: number;
  /** Цена за единицу с НДС */
  price?: number;
  /** Сумма с НДС */
  sum?: number;
  /** Сумма НДС */
  vat?: number;
  /** Упаковка "N x M" (для накладных, где количество в упаковках) */
  pack?: { count: number; size: number };
  issues: Issue[];
  /** Другие правдоподобные прочтения строки (для сверки с итогом документа) */
  alternatives?: { qty: number; price: number; sum: number }[];
  /** Исходная строка OCR, чтобы пользователь видел, откуда взялись числа */
  raw?: string;
}

export interface ParsedDoc {
  /** Идентификатор формата/парсера */
  format: string;
  formatName: string;
  supplier?: string;
  supplierBin?: string;
  number?: string;
  date?: string;
  items: ParsedItem[];
  totals?: { qty?: number; sum?: number; vat?: number; /** другие прочтения итога */ sumAlt?: number[] };
  issues: Issue[];
}

export const issue = (level: IssueLevel, text: string, kind?: string): Issue => (kind ? { level, text, kind } : { level, text });
