import { useMemo, useRef, useState } from 'react';
import { COLUMN_LABELS, type ExportColumn, type ExportSettings } from '../core/export';
import { exportMappingJson, parseMappingJson, type MappingStore } from '../core/mapping';
import { parseCatalogFile, type CatalogItem } from '../core/catalog';
import { ALL_COLUMNS, downloadBlob } from './storage';
import { IconX, IconTrash } from './Icons';

interface Props {
  open: boolean;
  tab: 'export' | 'catalog' | 'mapping';
  onTab: (t: Props['tab']) => void;
  onClose: () => void;
  settings: ExportSettings;
  onSettings: (s: ExportSettings) => void;
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
            <button type="button" className={p.tab === 'export' ? 'is-on' : ''} onClick={() => p.onTab('export')}>Файл для UMAG</button>
            <button type="button" className={p.tab === 'catalog' ? 'is-on' : ''} onClick={() => p.onTab('catalog')}>Каталог UMAG</button>
            <button type="button" className={p.tab === 'mapping' ? 'is-on' : ''} onClick={() => p.onTab('mapping')}>Справочник кодов</button>
          </div>
          <button type="button" className="icon-btn" onClick={p.onClose} aria-label="Закрыть"><IconX /></button>
        </div>

        {p.tab === 'export' && (
          <div className="drawer__body">
            <h3>Столбцы и их порядок</h3>
            <p className="muted">Порядок должен совпадать с тем, что вы выберете над столбцами в окне «Импорт товаров» UMAG. По умолчанию UMAG предлагает «Штрихкод», «Количество».</p>
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
              Первая строка — названия столбцов
              <span className="muted"> (UMAG может принять её за товар — тогда удалите её в окне импорта)</span>
            </label>
            <h3>Товары в упаковках</h3>
            <p className="muted">Когда в накладной «3 X 24» (3 упаковки по 24 шт), как выгружать количество:</p>
            <label className="check"><input type="radio" name="qm" checked={s.qtyMode === 'pcs'} onChange={() => p.onSettings({ ...s, qtyMode: 'pcs' })} /> В штуках (72 шт, цена за штуку)</label>
            <label className="check"><input type="radio" name="qm" checked={s.qtyMode === 'packs'} onChange={() => p.onSettings({ ...s, qtyMode: 'packs' })} /> В упаковках (3 уп, цена за упаковку)</label>
            <p className="muted">Цена в файле всегда с НДС — это то, что вы платите поставщику.</p>
          </div>
        )}

        {p.tab === 'catalog' && (
          <div className="drawer__body">
            <h3>Каталог товаров из UMAG</h3>
            <p className="muted">
              Выгрузите товары: UMAG → «Товары» → «Список товаров» → «Импорт/Экспорт» → «Экспорт товаров», и загрузите файл сюда.
              Тогда программа будет подсказывать штрихкод по названию и предупреждать, если товара из накладной нет в UMAG.
            </p>
            <p><b>{p.catalogSize ? `Загружено товаров: ${p.catalogSize}` : 'Каталог не загружен'}</b></p>
            <div className="row-btns">
              <button type="button" className="btn btn--primary" onClick={() => catRef.current?.click()}>Загрузить файл UMAG</button>
              {p.catalogSize > 0 && <button type="button" className="btn btn--ghost" onClick={() => p.onCatalog([])}><IconTrash /> Очистить</button>}
            </div>
            <input ref={catRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              try {
                const items = await parseCatalogFile(f);
                p.onCatalog(items);
                p.toast(`Каталог загружен: ${items.length} штрихкодов`);
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
              Заполняется сам, когда вы вводите штрихкод для товара с кодом поставщика (Мегаполис, Сэт Кола и т.п.).
              Хранится в этом браузере — сохраните файл, чтобы перенести на другой компьютер.
            </p>
            <div className="row-btns">
              <button type="button" className="btn" onClick={() => downloadBlob(exportMappingJson(p.mapping), 'umag-spravochnik.json')}>Сохранить в файл</button>
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
                    <span className="mono">{k.split('::')[1]}</span> → <span className="mono">{v.barcode}</span>
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
