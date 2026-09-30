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
  /**
   * Наименование слева от кода (форма З-2), справа (упаковочные листы, расходные накладные)
   * или штрихкод напечатан внутри наименования («… 95г / ШК: 4606779450709», Green House)
   */
  nameSide?: 'left' | 'right' | 'inline';
  /**
   * Между наименованием и кодом — столбец коротких номенклатурных номеров
   * («КЗ111», «ЯП104», «0349»), их не должно быть в наименовании
   */
  shortArticles?: boolean;
  /** Штрихкод не влез в ячейку: 12 цифр в строке кода, последняя цифра — строкой ниже (ЭльвиНиПлюс) */
  codeWrap?: boolean;
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
    // OCR читает название и как «Уирйег Agtobe»
    keywords: [/Yupiter/i, /Юпитер/i, /Yupi/, /Поставщик.*A[qg]tob/i],
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
  {
    // Мороженое: наименование в 2 строки, штрихкод перенесён — 12 цифр в первой строке, последняя во второй;
    // номенклатурный номер («0349») и числа — во второй строке
    id: 'elvi-ni-plus',
    name: 'ТОО "ЭльвиНиПлюс"',
    bins: [],
    keywords: [/Эльв[иu]\s*Н[иu]\s*П/i, /ЭльвиНи/i],
    parser: 'z2',
    z2: { code: 'ean', nameDir: 'down', rowAlign: 'top', codeWrap: true, shortArticles: true },
  },
  {
    // Молочка: штрихкод внутри наименования («… 100гр / ШК: 4605627007447»), количество «4,0000»,
    // цена и сумма по акции со скидкой
    id: 'green-house',
    name: 'Филиал ТОО "Green House Limited" Актобе',
    bins: ['201140022444'],
    keywords: [/Green\s*House/i],
    parser: 'z2',
    z2: { code: 'ean', nameDir: 'up', rowAlign: 'bottom', nameSide: 'inline' },
  },
  {
    // Кондитерка и снеки: номенклатурный номер «ЯП104» перед штрихкодом, весовые товары «4,5 кг»,
    // суммы округлены до тенге (3,8 × 1 446 = 5 495)
    id: 'kdv',
    name: 'ТОО "KDV Казахстан"',
    bins: ['041240000988'],
    keywords: [/KDV/, /kdvonline/i],
    parser: 'z2',
    z2: { code: 'ean', nameDir: 'up', shortArticles: true },
  },
  {
    // «Реализация товаров»: №, Артикул (= штрихкод), Товар, Количество и единица, Цена, Сумма; без НДС
    id: 'qazaq-trade',
    name: 'ИП Qazaq Trade',
    bins: [],
    // только строка «Поставщик»: печать «ИП QAZAQ TRADE» видна на краю соседних накладных в стопке
    keywords: [/Поставщик.*Q[a-zа-я]{2}aq/i],
    parser: 'z2',
    z2: { code: 'ean', nameDir: 'nearest', nameSide: 'right' },
  },
];

/** Настройки З-2 для неизвестного поставщика */
export const GENERIC_Z2: Z2Options = { code: 'digits', nameDir: 'nearest' };
