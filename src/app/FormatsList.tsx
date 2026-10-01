import { SUPPLIERS, type SupplierDef } from '../core/suppliers';

/** Откуда берётся штрихкод для UMAG у этого поставщика */
function codeNote(s: SupplierDef): { text: string; kind: 'ok' | 'once' | 'name' } {
  const code = s.z2?.code ?? 'digits';
  if (code === 'ean') return { text: 'штрихкод есть в накладной', kind: 'ok' };
  if (code === 'none') return { text: 'кодов нет — штрихкод по названию', kind: 'name' };
  return { text: 'свой код — штрихкод вводится один раз', kind: 'once' };
}

export const FORMATS_COUNT = SUPPLIERS.length;

/** Список накладных, которые система узнаёт (строится из справочника поставщиков — всегда актуален) */
export function FormatsList() {
  const list = [...SUPPLIERS].sort((a, b) => clean(a.name).localeCompare(clean(b.name), 'ru'));
  return (
    <ul className="formats">
      {list.map((s) => {
        const note = codeNote(s);
        return (
          <li key={s.id} className="formats__row">
            <span className="formats__name">{s.name}</span>
            <span className="formats__goods">{s.goods}</span>
            <span className={`formats__code formats__code--${note.kind}`}>{note.text}</span>
          </li>
        );
      })}
      <li className="formats__row formats__row--other">
        <span className="formats__name">Любой другой поставщик</span>
        <span className="formats__goods">форма З-2 и похожие таблицы</span>
        <span className="formats__code">столбцы определяются автоматически — проверьте внимательнее</span>
      </li>
    </ul>
  );
}

/** Для сортировки: без «ТОО», «ИП», «Филиал» и кавычек */
const clean = (name: string) => name.replace(/Филиал|ТОО|АО|ИП|ТК|Компания|["«»]/g, '').trim();
