/**
 * Справочник известных поставщиков и форматов их накладных.
 * Поставщик определяется по БИН (цифры OCR читает надёжнее всего) или по названию.
 * Чтобы добавить нового поставщика с накладной формы З-2 — достаточно новой записи.
 */

export type ParserId = 'z2' | 'setkola';

export interface Z2Options {
  /**
   * Какие коды стоят в строках товаров: штрихкоды EAN-8/13, коды поставщика
   * или никаких (тогда строки ищутся по столбцу сумм, а штрихкод — по названию)
   */
  code: 'ean' | 'digits' | 'none';
  /** Длина кода поставщика (для code = 'digits'), если известна */
  codeLength?: number;
  /**
   * Куда переносится длинное наименование относительно строки с кодом:
   * 'up' — первая часть названия выше кода (GRAND), 'down' — хвост ниже (Мегаполис).
   */
  nameDir: 'up' | 'down' | 'nearest';
  /** Наименование слева от кода (форма З-2) или справа (упаковочные листы, расходные накладные) */
  nameSide?: 'left' | 'right';
  /**
   * Где в строке стоят числа: на одной линии с кодом (center, по умолчанию),
   * внизу строки при коде у верхнего края (top) или на последней линии строки (bottom)
   */
  rowAlign?: 'center' | 'top' | 'bottom';
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
  {
    // Ferrero, Mars и др.: штрихкоды EAN-8 и EAN-13, левее — «Артикул»; код у верхнего края строки, числа внизу
    id: 'prima',
    name: 'ТОО "Прима Дистрибьюшн"',
    bins: ['081241007741'],
    keywords: [/Прима\s*Дистр/i, /prima-group/i],
    parser: 'z2',
    z2: { code: 'ean', nameDir: 'down', rowAlign: 'top' },
  },
  {
    // Сигареты блоками, номенклатурных номеров в накладной нет
    id: 'mayan',
    name: 'ТОО "MAYAN"',
    bins: ['210540001009'],
    keywords: [/MAYAN/i],
    parser: 'z2',
    z2: { code: 'none', nameDir: 'nearest' },
  },
  {
    // Форма З-8, коды из 11 цифр, есть столбцы «Вес тары», «% скидки», «Скидка»
    id: 'iskandyrov',
    name: 'ИП Искандыров',
    bins: [],
    keywords: [/Искандыров/i],
    parser: 'z2',
    z2: { code: 'digits', codeLength: 11, nameDir: 'up', rowAlign: 'bottom' },
  },
  {
    // Короткая накладная: Товар, Кол (упак), Кол-во, Цена, Сумма — без кодов
    id: 'carlsberg-pepsi',
    name: 'Карлсберг Пепси',
    bins: [],
    keywords: [/Карлсберг/i, /IM_KAZ/],
    parser: 'z2',
    z2: { code: 'none', nameDir: 'nearest' },
  },
  {
    // Упаковочный лист: код 6 цифр, наименование справа от кода (с NTIN), цена по прайсу и со скидкой.
    // Вторая страница без шапки — узнаём по «Внутренний номер» и NTIN.
    id: 'eurasian-foods',
    name: 'АО "Евразиан Фудс Корпорэйшн"',
    bins: ['001041004585'],
    keywords: [/Евразиан/i, /Упаковочн\S*\s+лист/i, /Внутренн\S*\s+номер[\s\S]*NTIN|NTIN[\s\S]*Внутренн\S*\s+номер/i],
    parser: 'z2',
    z2: { code: 'digits', codeLength: 6, nameDir: 'nearest', nameSide: 'right' },
  },
  {
    // Штрихкод левее номенклатурного номера, столбец «Коробок», бонусные строки с тем же штрихкодом по 1 ₸
    id: 'bes-batyr',
    name: 'ТОО "БЕС БАТЫР" Актобе',
    bins: [],
    keywords: [/БЕС\s*БАТЫР/i],
    parser: 'z2',
    z2: { code: 'ean', nameDir: 'nearest' },
  },
  {
    // Расходная накладная: NTIN, Штрихкод, Товар (справа), Общее «12 бут», Кор, Штук, Цена, Сумма
    id: 'yupiter',
    name: 'ТОО "Yupiter Aqtobe"',
    bins: [],
    keywords: [/Yupiter/i, /Юпитер/i],
    parser: 'z2',
    z2: { code: 'ean', nameDir: 'down', nameSide: 'right', rowAlign: 'top' },
  },
  {
    // Колбасы: штрихкод, код ТН ВЭД, «отпущено (кг)» между количеством и ценой
    id: 'nuraly-trans-kom',
    name: 'ТОО "НұралыТрансКом"',
    bins: ['080540015288'],
    keywords: [/Н[ұуy]ралы\s*Транс/i],
    parser: 'z2',
    z2: { code: 'ean', nameDir: 'up' },
  },
];

/** Настройки З-2 для неизвестного поставщика */
export const GENERIC_Z2: Z2Options = { code: 'digits', nameDir: 'nearest' };
