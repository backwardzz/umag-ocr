import { useMemo, useRef, useState } from 'react';
import { COLUMN_LABELS, DEFAULT_UNIT_RULES, type ExportColumn, type ExportSettings, type UnitRule } from '../core/export';
import { exportMappingJson, parseMappingJson, type MappingStore } from '../core/mapping';
import { parseCatalogFile, type CatalogItem } from '../core/catalog';
import { ALL_COLUMNS, downloadBlob } from './storage';
import { IconX, IconTrash, IconPlus } from './Icons';
import { UNITS } from './model';

interface Props {
  open: boolean;
  tab: 'export' | 'catalog' | 'mapping';
  onTab: (t: Props['tab']) => void;
  onClose: () => void;
  settings: ExportSettings;
  onSettings: (s: ExportSettings) => void;
  /** Применить правила пересчёта единиц к уже открытым накладным */
  onApplyRules: () => void;
  catalogSize: number;
  onCatalog: (items: CatalogItem[]) => void;
  mapping: MappingStore;
  onMapping: (m: MappingStore) => void;
  toast: (t: string) => void;
}

export function SettingsDrawer(p: Props) {
  const catRef = useRef<HTMLInputElement>(null);
  const mapRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const { settings: s } = p;

  const move = (c: ExportColumn, dir: -1 | 1) => {
    const cols = [...s.columns];
    const i = cols.indexOf(c);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= cols.length) return;
    [cols[i], cols[j]] = [cols[j], cols[i]];
    p.onSettings({ ...s, columns: cols });
  };
  const setRule = (i: number, patch: Partial<UnitRule>) =>
    p.onSettings({ ...s, unitRules: s.unitRules.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  const toggle = (c: ExportColumn) => {
    const on = s.columns.includes(c);
    if (on && s.columns.length === 1) return;
    p.onSettings({ ...s, columns: on ? s.columns.filter((x) => x !== c) : [...s.columns, c] });
  };

  const entries = useMemo(() => {
    const all = Object.entries(p.mapping).sort((a, b) => (b[1].updated ?? '').localeCompare(a[1].updated ?? ''));
    const t = q.trim().toLowerCase();
    return t ? all.filter(([k, v]) => k.toLowerCase().includes(t) || v.barcode.includes(t) || (v.name ?? '').toLowerCase().includes(t)) : all;
  }, [p.mapping, q]);

  if (!p.open) return null;
  const ordered = [...s.columns, ...ALL_COLUMNS.filter((c) => !s.columns.includes(c))];

  return (
    <div className="drawer-backdrop" onClick={p.onClose}>
      <aside className="drawer" role="dialog" aria-label="Настройки" onClick={(e) => e.stopPropagation()}>
        <div className="drawer__head">
          <div className="seg" role="tablist">
            <button type="button" className={p.tab === 'export' ? 'is-on' : ''} onClick={() => p.onTab('export')}>Файл Excel</button>
            <button type="button" className={p.tab === 'catalog' ? 'is-on' : ''} onClick={() => p.onTab('catalog')}>Каталог Sauda</button>
            <button type="button" className={p.tab === 'mapping' ? 'is-on' : ''} onClick={() => p.onTab('mapping')}>Справочник кодов</button>
          </div>
          <button type="button" className="icon-btn" onClick={p.onClose} aria-label="Закрыть"><IconX /></button>
        </div>

        {p.tab === 'export' && (
          <div className="drawer__body">
            <h3>Столбцы и их порядок</h3>
            <p className="muted">В таком порядке столбцы попадут в файл Excel и в буфер обмена по кнопке «Копировать». На кнопку «В Sauda» порядок не влияет.</p>
            <ul className="colpick">
              {ordered.map((c) => {
                const on = s.columns.includes(c);
                const idx = s.columns.indexOf(c);
                return (
                  <li key={c} className={on ? '' : 'is-off'}>
                    <label><input type="checkbox" checked={on} onChange={() => toggle(c)} /> {on ? `${idx + 1}. ` : ''}{COLUMN_LABELS[c]}</label>
                    {on && (
                      <span className="colpick__move">
                        <button type="button" className="icon-btn" disabled={idx === 0} onClick={() => move(c, -1)} aria-label="Выше">↑</button>
                        <button type="button" className="icon-btn" disabled={idx === s.columns.length - 1} onClick={() => move(c, 1)} aria-label="Ниже">↓</button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            <label className="check">
              <input type="checkbox" checked={s.header} onChange={(e) => p.onSettings({ ...s, header: e.target.checked })} />
              Первая строка — названия столбцов            </label>
            <h3>Товары в упаковках</h3>
            <p className="muted">Когда в накладной «3 X 24» (3 упаковки по 24 шт), как выгружать количество:</p>
            <label className="check"><input type="radio" name="qm" checked={s.qtyMode === 'pcs'} onChange={() => p.onSettings({ ...s, qtyMode: 'pcs' })} /> В штуках (72 шт, цена за штуку)</label>
            <label className="check"><input type="radio" name="qm" checked={s.qtyMode === 'packs'} onChange={() => p.onSettings({ ...s, qtyMode: 'packs' })} /> В упаковках (3 уп, цена за упаковку)</label>
            <p className="muted">Цена в файле всегда с НДС — это то, что вы платите поставщику.</p>
            <h3>Пересчёт единиц</h3>
            <p className="muted">
              При загрузке накладной строки с такой единицей пересчитываются так, как их принимает Sauda: количество
              умножается, цена делится (1 блок по 11 618 → 10 шт по 1 161,80), единица меняется. Сумма остаётся
              как в накладной. Исходные количество и цена видны под строкой, вернуть их можно
              кнопкой «Как в накладной» над таблицей.
            </p>
            <datalist id="units-list">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
            <ul className="rules">
              {s.unitRules.map((r, i) => (
                <li key={i} className="rules__row">
                  <span>1</span>
                  <input className="rules__unit" list="units-list" value={r.from} aria-label="Единица в накладной" onChange={(e) => setRule(i, { from: e.target.value })} />
                  <span>=</span>
                  <input className="rules__num" type="number" min="0" step="any" value={r.factor} aria-label="Сколько" onChange={(e) => setRule(i, { factor: Number(e.target.value) })} />
                  <input className="rules__unit" list="units-list" value={r.to} aria-label="Единица в Sauda" onChange={(e) => setRule(i, { to: e.target.value })} />
                  <button type="button" className="icon-btn" aria-label="Удалить правило" onClick={() => p.onSettings({ ...s, unitRules: s.unitRules.filter((_, k) => k !== i) })}><IconTrash /></button>
                </li>
              ))}
            </ul>
            <div className="row-btns">
              <button type="button" className="btn" onClick={() => p.onSettings({ ...s, unitRules: [...s.unitRules, { from: '', to: 'шт', factor: 1 }] })}><IconPlus /> Добавить правило</button>
              {s.unitRules.length === 0 && (
                <button type="button" className="btn btn--ghost" onClick={() => p.onSettings({ ...s, unitRules: DEFAULT_UNIT_RULES })}>Вернуть «1 блок = 10 шт»</button>
              )}
              <button type="button" className="btn btn--ghost" onClick={p.onApplyRules}>Применить к открытым накладным</button>
            </div>
          </div>
        )}

        {p.tab === 'catalog' && (
          <div className="drawer__body">
            <h3>Каталог товаров из Sauda</h3>
            <p className="muted">
              Выгрузите товары: Sauda → «Товары» → «Список товаров» → «Импорт/Экспорт» → «Экспорт товаров», и загрузите файл сюда.
              Файл загружается один раз и хранится только в этом браузере (на другом устройстве загрузите его ещё раз).
            </p>
            <p className="muted">
              Если в накладной нет штрихкода, программа <b>заполнит его автоматически</b>: по коду NTIN, а если его нет —
              по похожему названию, с учётом объёма, веса и поставщика. Такие строки помечаются «автозаполнение · возможна ошибка»:
              сверьте товар и нажмите «верно». Ещё каталог подсказывает штрихкод в выпадающем списке и предупреждает,
              если товара из накладной нет в Sauda.
            </p>
            <p className="muted">
              Если штрихкод из накладной прочитан с ошибкой (не сходится контрольная цифра) и в каталоге есть ровно один
              похожий, штрихкод <b>исправляется по каталогу</b> — строка помечается «исправлен по каталогу · сверьте».
            </p>
            <p className="muted">
              <b>Названия берутся из каталога:</b> если штрихкод строки есть в каталоге (из накладной, из справочника,
              подобран автоматически или введён вручную), название заменяется названием из Sauda — так оно и попадёт в файл.
              Название из накладной видно под ним серым. Если исправить название вручную, оно больше не заменяется.
            </p>
            <p><b>{p.catalogSize ? `Загружено товаров: ${p.catalogSize}` : 'Каталог не загружен'}</b></p>
            <div className="row-btns">
              <button type="button" className="btn btn--primary" onClick={() => catRef.current?.click()}>Загрузить файл Sauda</button>
              {p.catalogSize > 0 && <button type="button" className="btn btn--ghost" onClick={() => p.onCatalog([])}><IconTrash /> Очистить</button>}
            </div>
            <input ref={catRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              try {
                const items = await parseCatalogFile(f);
                p.onCatalog(items);
                p.toast(`Каталог загружен: ${items.length} товаров — штрихкоды заполнены там, где их не было, названия взяты из каталога`);
              } catch (err) {
                p.toast(String((err as Error).message ?? err));
              }
            }} />
          </div>
        )}

        {p.tab === 'mapping' && (
          <div className="drawer__body">
            <h3>Код поставщика → штрихкод</h3>
            <p className="muted">
              Заполняется сам, когда вы вводите штрихкод для товара с кодом поставщика (Мегаполис, Сэт Кола, Евразиан и т.п.)
              или для товара без кода — тогда он запоминается по названию (MAYAN, Карлсберг Пепси).
              Хранится в этом браузере — сохраните файл, чтобы перенести на другой компьютер.
            </p>
            <div className="row-btns">
              <button type="button" className="btn" onClick={() => downloadBlob(exportMappingJson(p.mapping), 'sauda-spravochnik.json')}>Сохранить в файл</button>
              <button type="button" className="btn" onClick={() => mapRef.current?.click()}>Загрузить из файла</button>
            </div>
            <input ref={mapRef} type="file" accept=".json" hidden onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              try {
                const m = parseMappingJson(await f.text());
                p.onMapping({ ...p.mapping, ...m });
                p.toast(`Добавлено записей: ${Object.keys(m).length}`);
              } catch (err) {
                p.toast(String((err as Error).message ?? err));
              }
            }} />
            <input className="search" placeholder="Поиск по коду, штрихкоду, названию" value={q} onChange={(e) => setQ(e.target.value)} />
            <p className="muted">Записей: {Object.keys(p.mapping).length}</p>
            <ul className="maplist">
              {entries.slice(0, 300).map(([k, v]) => (
                <li key={k}>
                  <span className="maplist__main">
                    {k.split('::')[1].startsWith('name:')
                      ? <span>«{v.name}»</span>
                      : <span className="mono">{k.split('::')[1]}</span>} → <span className="mono">{v.barcode}</span>
                    <span className="muted maplist__name">{v.supplier ? `${v.supplier} · ` : ''}{v.name}</span>
                  </span>
                  <button type="button" className="icon-btn" aria-label="Удалить" onClick={() => {
                    const m = { ...p.mapping };
                    delete m[k];
                    p.onMapping(m);
                  }}><IconTrash /></button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}
