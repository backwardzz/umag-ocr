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
  /** Штрихкод для Sauda (из накладной, если это EAN, или из справочника) */
  barcode?: string;
  /** Откуда взят штрихкод; catalog — автозаполнение из каталога Sauda (возможны ошибки) */
  barcodeSource?: 'invoice' | 'mapping' | 'manual' | 'catalog';
  /**
   * Для автозаполнения: товар каталога, с которым сопоставлена строка, и как — по коду, по названию
   * или fix: штрихкод из накладной прочитан с ошибкой и заменён похожим из каталога
   */
  catalogMatch?: { name: string; by: 'code' | 'name' | 'fix' };
  /** Штрихкод, как его прочитал OCR, если он исправлен по каталогу (вернётся, когда каталог очистят) */
  ocrBarcode?: string;
  /**
   * Основной штрихкод товара Sauda, найденного по штрихкоду строки. У одного товара Sauda бывает
   * несколько штрихкодов (вкусы одного товара — дополнительными): такие строки в файле складываются.
   */
  catalogBarcode?: string;
  /**
   * Штрихкод строки до замены: он записан у товара Sauda дополнительным («Доп. код», колонка D выгрузки),
   * поэтому barcode заменён основным штрихкодом товара (колонка B). Вернётся, если каталог очистят.
   */
  altBarcode?: string;
  /** Другие коды строки (NTIN), по которым товар можно найти в каталоге Sauda */
  extraCodes?: string[];
  /** Строка добавлена вручную кнопкой «Добавить строку» — в накладной (на фото) её не было */
  added?: boolean;
  /** Строку правили вручную — замечания OCR к ней больше не актуальны */
  edited?: boolean;
  /** Пользователь сверил строку с накладной: предупреждения (жёлтые) сняты, ошибки остаются */
  approved?: boolean;
  name: string;
  /**
   * Название, как оно напечатано в накладной (прочитано OCR). Заполняется, когда name
   * заменено названием из каталога: по нему ищем товар в каталоге и в справочнике.
   */
  invoiceName?: string;
  /** Откуда name: catalog — из каталога Sauda по штрихкоду, manual — исправлено вручную; нет — из накладной */
  nameSource?: 'catalog' | 'manual';
  unit?: string;
  /**
   * Количество, единица и цена, как в накладной, — если их поменял пересчёт единиц
   * (1 блок = 10 шт) или массовая правка. По ним строку можно вернуть к накладной.
   */
  orig?: { qty?: number; unit?: string; price?: number };
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
  /** Все прочтения цены и число подтверждений выбранного варианта — для восстановления строки по итогу */
  readings?: { price: number[]; sum: number[]; support: number };
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
  /** Сколько фото (страниц) склеено в эту накладную */
  pages?: number;
}

export const issue = (level: IssueLevel, text: string, kind?: string): Issue => (kind ? { level, text, kind } : { level, text });

/** Название из накладной — для поиска в каталоге и справочнике (name могло быть заменено названием из каталога) */
export const sourceName = (it: { name: string; invoiceName?: string }) => it.invoiceName ?? it.name;
