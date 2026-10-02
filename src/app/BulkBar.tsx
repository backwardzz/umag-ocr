import { useMemo, useState } from 'react';
import type { UnitRule } from '../core/export';
import type { ParsedItem } from '../core/types';
import { ruleFor, UNITS, type BulkOp } from './model';

interface Props {
  items: ParsedItem[];
  selected: Set<number>;
  onSelect: (rows: Set<number>) => void;
  rules: UnitRule[];
  onBulk: (rows: number[], op: BulkOp) => void;
  canUndo: boolean;
  onUndo: () => void;
}

const num = (s: string) => {
  const v = Number(s.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : undefined;
};
const unitLabel = (u?: string) => u || 'без ед.';

/**
 * Массовые правки над таблицей: выбор строк (все, по единице, галочками) и действия
 * над выбранными — а если ничего не выбрано, над всеми строками. Сумма не меняется никогда.
 */
export function BulkBar({ items, selected, onSelect, rules, onBulk, canUndo, onUndo }: Props) {
  const [field, setField] = useState<'qty' | 'price'>('qty');
  const [dir, setDir] = useState<'mul' | 'div'>('mul');
  const [factor, setFactor] = useState('10');
  const [unit, setUnit] = useState('шт');

  const all = useMemo(() => items.map((_, i) => i), [items]);
  const targets = selected.size ? [...selected].sort((a, b) => a - b) : all;
  const scope = selected.size ? `к выбранным (${selected.size})` : `ко всем строкам (${items.length})`;

  // Единицы в накладной — для быстрого выбора строк «все блоки»
  const byUnit = useMemo(() => {
    const m = new Map<string, number[]>();
    items.forEach((it, i) => m.set(it.unit ?? '', [...(m.get(it.unit ?? '') ?? []), i]));
    return [...m.entries()];
  }, [items]);

  // Пресеты из правил пересчёта: к выбранным, а без выбора — ко всем строкам с этой единицей
  const presets = rules.filter((r) => r.from.trim() && r.factor > 0).map((r) => {
    const rows = targets.filter((i) => selected.size || ruleFor(items[i].unit, [r]));
    return { r, rows };
  });
  const restorable = targets.filter((i) => items[i].orig).length;
  const f = num(factor);

  const run = (op: BulkOp, rows = targets) => { if (rows.length) onBulk(rows, op); };
  const scale = () => { if (f) run({ kind: 'scale', field, factor: dir === 'mul' ? f : 1 / f }); };

  return (
    <div className="bulk" role="toolbar" aria-label="Массовые правки строк">
      <div className="bulk__row">
        <span className="bulk__label">Строки:</span>
        <button type="button" className="chipbtn" onClick={() => onSelect(new Set(all))}>все</button>
        {selected.size > 0 && <button type="button" className="chipbtn" onClick={() => onSelect(new Set())}>снять выбор</button>}
        {byUnit.length > 1 && byUnit.map(([u, rows]) => {
          const on = rows.length === selected.size && rows.every((i) => selected.has(i));
          return (
            <button key={u} type="button" className={`chipbtn ${on ? 'is-on' : ''}`} aria-pressed={on} title={`Выбрать строки с единицей «${unitLabel(u)}»`}
              onClick={() => onSelect(new Set(on ? [] : rows))}>
              {unitLabel(u)} · {rows.length}
            </button>
          );
        })}
        <span className="bulk__scope muted">Действия — {scope}</span>
        {canUndo && <button type="button" className="btn btn--ghost bulk__undo" onClick={onUndo}>Отменить</button>}
      </div>
      <div className="bulk__row">
        {presets.map(({ r, rows }) => (
          <button key={`${r.from}-${r.to}-${r.factor}`} type="button" className="btn" disabled={!rows.length}
            title={`Количество × ${r.factor}, цена ÷ ${r.factor}, единица «${r.to}»; сумма — как в накладной`}
            onClick={() => run({ kind: 'convert', factor: r.factor, unit: r.to }, rows)}>
            1 {r.from} → {r.factor} {r.to}{!selected.size && rows.length ? ` (${rows.length})` : ''}
          </button>
        ))}
        <span className="bulk__group">
          <select value={field} onChange={(e) => setField(e.target.value as 'qty' | 'price')} aria-label="Что менять">
            <option value="qty">Кол-во</option>
            <option value="price">Цена</option>
          </select>
          <select value={dir} onChange={(e) => setDir(e.target.value as 'mul' | 'div')} aria-label="Действие">
            <option value="mul">×</option>
            <option value="div">÷</option>
          </select>
          <input className="bulk__num" inputMode="decimal" value={factor} aria-label="На сколько"
            onChange={(e) => setFactor(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') scale(); }} />
          <button type="button" className="btn" disabled={!f} onClick={scale}>Применить</button>
        </span>
        <span className="bulk__group">
          <span className="bulk__label">Ед. изм</span>
          <input className="bulk__unit" list="units-bulk" value={unit} aria-label="Новая единица"
            onChange={(e) => setUnit(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') run({ kind: 'unit', unit: unit.trim() }); }} />
          <datalist id="units-bulk">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
          <button type="button" className="btn" onClick={() => run({ kind: 'unit', unit: unit.trim() })}>Поставить</button>
        </span>
        <button type="button" className="btn btn--ghost" disabled={!restorable} title="Вернуть количество, единицу и цену как в накладной"
          onClick={() => run({ kind: 'restore' })}>
          Как в накладной{restorable ? ` (${restorable})` : ''}
        </button>
      </div>
      <p className="bulk__hint muted">
        Сумма не меняется — она как в накладной. В поле количества можно набрать <kbd>*10</kbd> или <kbd>/10</kbd>.
        Выбор диапазона — галочка с <kbd>Shift</kbd>.
      </p>
    </div>
  );
}
