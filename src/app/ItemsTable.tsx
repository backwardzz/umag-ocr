import { useEffect, useMemo, useState } from 'react';
import type { CatalogIndex } from '../core/catalog';
import type { ParsedItem } from '../core/types';
import { allIssues, worstLevel, money, qtyFmt } from './model';
import { IconAlert, IconBarcode, IconCheck, IconPlus, IconX } from './Icons';

interface Props {
  items: ParsedItem[];
  catalog?: CatalogIndex;
  onChange: (index: number, patch: Partial<ParsedItem>) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}

function parseNum(s: string): number | undefined {
  const t = s.replace(/\s/g, '').replace(',', '.');
  if (!t) return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}

/** Числовое поле: принимает и запятую, и точку; сохраняет по уходу из поля */
function NumInput({ value, onCommit, label, invalid, money }: { value?: number; onCommit: (v?: number) => void; label: string; invalid?: boolean; money?: boolean }) {
  const fmt = (v?: number) => (v === undefined ? '' : (money ? v.toFixed(2) : String(v)).replace('.', ','));
  const [text, setText] = useState(fmt(value));
  useEffect(() => setText(fmt(value)), [value]);
  const commit = () => {
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

export function ItemsTable({ items, catalog, onChange, onRemove, onAdd }: Props) {
  const rows = useMemo(() => items.map((it, i) => {
    const issues = allIssues(it, catalog);
    const suggestions = !it.barcode && catalog && catalog.size ? catalog.suggest(it.name) : [];
    // тот же штрихкод выше (бонусная строка) — в файле строки сложатся
    const first = it.barcode ? items.findIndex((x) => x.barcode === it.barcode) : -1;
    return { it, issues, level: worstLevel(issues), suggestions, sameAs: first >= 0 && first < i ? first : undefined };
  }), [items, catalog]);

  return (
    <div className="table-wrap">
      <table className="items">
        <thead>
          <tr>
            <th className="c-n">№</th>
            <th className="c-bc">Штрихкод</th>
            <th className="c-name">Наименование</th>
            <th className="c-num">Кол-во</th>
            <th className="c-unit">Ед. изм</th>
            <th className="c-num">Цена, ₸</th>
            <th className="c-num">Сумма, ₸</th>
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
              <tr key={i} className={`row row--${level}`}>
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
                    {suggestions.length > 0 && <span className="tag tag--hint">есть подсказки: {suggestions.length}</span>}
                    {sameAs !== undefined && <span className="tag" title="В файле для UMAG строки с одинаковым штрихкодом складываются">сложится со строкой {sameAs + 1}</span>}
                  </div>
                </td>
                <td className="c-name">
                  <TextInput value={it.name} label={`Наименование, строка ${i + 1}`} onCommit={(v) => onChange(i, { name: v })} />
                  {shown.length > 0 && (
                    <ul className="row-issues">
                      {shown.map((x, k) => <li key={k} className={`row-issue row-issue--${x.level}`}>{x.text}</li>)}
                    </ul>
                  )}
                </td>
                <td className="c-num">
                  <NumInput value={it.qty} label={`Количество, строка ${i + 1}`} invalid={!it.qty} onCommit={(v) => onChange(i, { qty: v })} />
                  {it.pack && (
                    <div className="cell-sub cell-sub--num">{qtyFmt(it.pack.count)} уп × {it.pack.size}</div>
                  )}
                </td>
                <td className="c-unit">
                  <TextInput value={it.unit ?? ''} label={`Ед. изм, строка ${i + 1}`} onCommit={(v) => onChange(i, { unit: v || undefined })} />
                </td>
                <td className="c-num">
                  <NumInput money value={it.price} label={`Цена, строка ${i + 1}`} invalid={it.price === undefined} onCommit={(v) => onChange(i, { price: v })} />
                </td>
                <td className="c-num c-sum">{money(it.sum)}</td>
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
      <button type="button" className="btn btn--ghost add-row" onClick={onAdd}><IconPlus /> Добавить строку</button>
    </div>
  );
}
