import { useEffect, useMemo, useState } from 'react';
import type { CatalogIndex } from '../core/catalog';
import { sourceName, type ParsedItem } from '../core/types';
import { allIssues, worstLevel, money, qtyFmt, UNITS } from './model';
import { IconAlert, IconBarcode, IconCheck, IconPlus, IconX } from './Icons';

interface Props {
  items: ParsedItem[];
  catalog?: CatalogIndex;
  onChange: (index: number, patch: Partial<ParsedItem>) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  /** Выбранные строки для массовых правок */
  selected: Set<number>;
  onToggle: (index: number, range: boolean) => void;
  onToggleAll: (on: boolean) => void;
  /** «*10» или «/10» в поле количества или цены: пересчёт без изменения суммы */
  onScale: (index: number, field: 'qty' | 'price', factor: number) => void;
}

function parseNum(s: string): number | undefined {
  const t = s.replace(/\s/g, '').replace(',', '.');
  if (!t) return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}

/** «*10», «x10», «×10», «/10», «÷10» — во сколько раз изменить значение */
function parseScale(s: string): number | undefined {
  const m = s.trim().match(/^([*xх×/÷:])\s*(\d+(?:[.,]\d+)?)$/i);
  if (!m) return undefined;
  const f = Number(m[2].replace(',', '.'));
  if (!(f > 0)) return undefined;
  return /[/÷:]/.test(m[1]) ? 1 / f : f;
}

/**
 * Числовое поле: принимает и запятую, и точку; сохраняет по уходу из поля.
 * «*10» или «/10» — умножить или разделить текущее значение (onScale).
 */
function NumInput({ value, onCommit, onScale, label, invalid, money }: {
  value?: number; onCommit: (v?: number) => void; onScale?: (factor: number) => void; label: string; invalid?: boolean; money?: boolean;
}) {
  const fmt = (v?: number) => (v === undefined ? '' : (money ? v.toFixed(2) : String(v)).replace('.', ','));
  const [text, setText] = useState(fmt(value));
  useEffect(() => setText(fmt(value)), [value]);
  const commit = () => {
    const f = onScale ? parseScale(text) : undefined;
    if (f !== undefined) {
      setText(fmt(value));
      if (f !== 1) onScale!(f);
      return;
    }
    const v = parseNum(text);
    if (v !== value) onCommit(v);
    else setText(fmt(value));
  };
  return (
    <input
      className={`cell-input cell-input--num ${invalid ? 'is-invalid' : ''}`}
      inputMode="decimal"
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

function TextInput({ value, onCommit, label, className, list, placeholder, invalid, onEnter, dataRow }: {
  value: string; onCommit: (v: string) => void; label: string; className?: string; list?: string; placeholder?: string; invalid?: boolean;
  onEnter?: () => void; dataRow?: number;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className={`cell-input ${className ?? ''} ${invalid ? 'is-invalid' : ''}`}
      aria-label={label}
      value={text}
      list={list}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      data-row={dataRow}
      onBlur={() => { if (text.trim() !== value) onCommit(text.trim()); }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        (e.target as HTMLInputElement).blur();
        onEnter?.();
      }}
    />
  );
}

/** После ввода штрихкода (вручную или сканером — он «нажимает» Enter) — к следующей пустой строке */
function focusNextEmptyBarcode(from: number) {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-row]'));
  const next = inputs.find((el) => Number(el.dataset.row) > from && !el.value);
  if (next) {
    next.focus();
    next.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

export function ItemsTable({ items, catalog, onChange, onRemove, onAdd, selected, onToggle, onToggleAll, onScale }: Props) {
  const rows = useMemo(() => items.map((it, i) => {
    const issues = allIssues(it, catalog);
    const suggestions = !it.barcode && catalog && catalog.size ? catalog.suggest(sourceName(it)) : [];
    // тот же штрихкод выше (бонусная строка) — в файле строки сложатся
    // и другой штрихкод того же товара UMAG (вкус, заведённый дополнительным штрихкодом)
    const first = it.barcode ? items.findIndex((x) => x.barcode === it.barcode || (!!it.catalogBarcode && x.catalogBarcode === it.catalogBarcode)) : -1;
    return { it, issues, level: worstLevel(issues), suggestions, sameAs: first >= 0 && first < i ? first : undefined };
  }), [items, catalog]);

  return (
    <div className="table-wrap">
      <table className="items">
        <thead>
          <tr>
            <th className="c-sel">
              <input type="checkbox" aria-label="Выбрать все строки" checked={items.length > 0 && selected.size === items.length}
                ref={(el) => { if (el) el.indeterminate = selected.size > 0 && selected.size < items.length; }}
                onChange={(e) => onToggleAll(e.target.checked)} />
            </th>
            <th className="c-n">№</th>
            <th className="c-bc">Штрихкод</th>
            <th className="c-name">Наименование</th>
            <th className="c-num c-qty">Кол-во</th>
            <th className="c-unit">Ед. изм</th>
            <th className="c-num c-price">Цена, ₸</th>
            <th className="c-num c-sum">Сумма, ₸</th>
            <th className="c-st" aria-label="Статус" />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ it, issues, level, suggestions, sameAs }, i) => {
            // «нет штрихкода» видно по красному полю — отдельной строкой не дублируем
            const shown = issues.filter((x) => x.level !== 'info' && x.kind !== 'barcode');
            const infos = issues.filter((x) => x.level === 'info');
            const listId = suggestions.length ? `sugg-${i}` : undefined;
            return (
              <tr key={i} className={`row row--${level} ${selected.has(i) ? 'is-selected' : ''}`}>
                <td className="c-sel">
                  <input type="checkbox" aria-label={`Выбрать строку ${i + 1}`} checked={selected.has(i)} readOnly
                    onClick={(e) => onToggle(i, e.shiftKey)} />
                </td>
                <td className="c-n">{i + 1}</td>
                <td className="c-bc">
                  <TextInput
                    value={it.barcode ?? ''}
                    label={`Штрихкод, строка ${i + 1}`}
                    className="cell-input--mono"
                    placeholder={it.code ? 'введите штрихкод' : ''}
                    list={listId}
                    invalid={!it.barcode}
                    dataRow={i}
                    onEnter={() => setTimeout(() => focusNextEmptyBarcode(i), 0)}
                    onCommit={(v) => onChange(i, { barcode: v.replace(/\s/g, '') || undefined })}
                  />
                  {listId && (
                    <datalist id={listId}>
                      {suggestions.map((s) => <option key={s.item.barcode} value={s.item.barcode}>{s.item.name}</option>)}
                    </datalist>
                  )}
                  <div className="cell-sub">
                    {it.code && it.code !== it.barcode && <span>код {it.code}{it.codeAlt && !it.barcode ? ` / ${it.codeAlt}` : ''}</span>}
                    {it.barcodeSource === 'mapping' && <span className="tag">из справочника</span>}
                    {it.barcodeSource === 'catalog' && (
                      <>
                        {it.catalogMatch?.by === 'fix' ? (
                          <span className="tag tag--hint" title={`В накладной прочитано ${it.ocrBarcode ?? ''}, в каталоге UMAG похожий: ${it.catalogMatch.name}`}>
                            исправлен по каталогу · сверьте
                          </span>
                        ) : (
                          <span className="tag tag--hint" title={`Найдено в каталоге UMAG: ${it.catalogMatch?.name ?? ''}`}>
                            автозаполнение · возможна ошибка
                          </span>
                        )}
                        <button type="button" className="tag tag--btn" title="Штрихкод верный — запомнить для этого товара"
                          onClick={() => onChange(i, { barcode: it.barcode })}>
                          верно
                        </button>
                      </>
                    )}
                    {suggestions.length > 0 && <span className="tag tag--hint">есть подсказки: {suggestions.length}</span>}
                    {sameAs !== undefined && <span className="tag" title="В файле для UMAG складываются строки с одинаковым штрихкодом и разные штрихкоды одного товара UMAG">сложится со строкой {sameAs + 1}</span>}
                  </div>
                </td>
                <td className="c-name">
                  <TextInput value={it.name} label={`Наименование, строка ${i + 1}`} onCommit={(v) => onChange(i, { name: v })} />
                  {it.invoiceName && it.invoiceName !== it.name && (
                    <div className="cell-sub">
                      {it.nameSource === 'catalog' && (
                        <span className="tag" title="Название взято из каталога UMAG по штрихкоду — так оно попадёт в файл">из базы</span>
                      )}
                      <span className="cell-sub__orig" title="Название, как оно напечатано в накладной">в накладной: {it.invoiceName}</span>
                    </div>
                  )}
                  {shown.length > 0 && (
                    <ul className="row-issues">
                      {shown.map((x, k) => <li key={k} className={`row-issue row-issue--${x.level}`}>{x.text}</li>)}
                    </ul>
                  )}
                  {shown.some((x) => x.level === 'warn') && (
                    <button type="button" className="approve" title="Строка сверена с накладной — снять предупреждение"
                      // автозаполненный штрихкод заодно запоминается в справочнике, как по кнопке «верно»
                      onClick={() => onChange(i, it.barcodeSource === 'catalog' ? { barcode: it.barcode, approved: true } : { approved: true })}>
                      <IconCheck /> Проверено
                    </button>
                  )}
                  {it.approved && (
                    <div className="cell-sub">
                      <button type="button" className="tag tag--btn" title="Вернуть предупреждения этой строки"
                        onClick={() => onChange(i, { approved: false })}>
                        проверено · вернуть замечания
                      </button>
                    </div>
                  )}
                </td>
                <td className="c-num c-qty" data-label="Кол-во">
                  <NumInput value={it.qty} label={`Количество, строка ${i + 1}`} invalid={!it.qty} onCommit={(v) => onChange(i, { qty: v })} onScale={(f) => onScale(i, 'qty', f)} />
                  {it.orig && (it.orig.qty !== it.qty || it.orig.unit !== it.unit) && (
                    <div className="cell-sub cell-sub--num" title="Так в накладной — количество и цена пересчитаны под приёмку UMAG (сумма как в накладной)">
                      было {qtyFmt(it.orig.qty)} {it.orig.unit ?? ''}
                    </div>
                  )}
                  {it.pack && (
                    <div className="cell-sub cell-sub--num">{qtyFmt(it.pack.count)} уп × {it.pack.size}</div>
                  )}
                </td>
                <td className="c-unit" data-label="Ед.">
                  <TextInput value={it.unit ?? ''} label={`Ед. изм, строка ${i + 1}`} list="units-table" onCommit={(v) => onChange(i, { unit: v || undefined })} />
                </td>
                <td className="c-num c-price" data-label="Цена, ₸">
                  <NumInput money value={it.price} label={`Цена, строка ${i + 1}`} invalid={it.price === undefined} onCommit={(v) => onChange(i, { price: v })} onScale={(f) => onScale(i, 'price', f)} />
                  {it.orig && it.orig.price !== it.price && <div className="cell-sub cell-sub--num" title="Цена в накладной">было {money(it.orig.price)}</div>}
                </td>
                <td className="c-num c-sum" data-label="Сумма, ₸">{money(it.sum)}</td>
                <td className="c-st">
                  <span
                    className={`st st--${level}`}
                    title={[...shown, ...infos].map((x) => x.text).join('\n') || 'Всё сходится'}
                  >
                    {level === 'ok' ? <IconCheck /> : level === 'todo' ? <IconBarcode /> : <IconAlert />}
                  </span>
                  <button type="button" className="icon-btn" title="Удалить строку" aria-label={`Удалить строку ${i + 1}`} onClick={() => onRemove(i)}>
                    <IconX />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <datalist id="units-table">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
      <button type="button" className="btn btn--ghost add-row" onClick={onAdd}><IconPlus /> Добавить строку</button>
    </div>
  );
}
