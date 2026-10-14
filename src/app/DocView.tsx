import { useEffect, useRef, useState } from 'react';
import type { CatalogIndex } from '../core/catalog';
import type { ParsedDoc, ParsedItem } from '../core/types';
import { buildRows, exportFileName, mergedLineCount, toTsv, toXlsxBlob, toReportBlob, type ExportSettings } from '../core/export';
import { approveAll, isContinuation, summarize, money, qtyFmt, type BulkOp, type DocEntry } from './model';
import { ItemsTable } from './ItemsTable';
import { BulkBar } from './BulkBar';
import { PhotoViewer } from './PhotoViewer';
import { saudaBase, saudaLink, saudaOverride } from '../core/sauda';
import { downloadBlob, copyText } from './storage';
import { IconCopy, IconDownload, IconTrash, IconAlert, IconCheck, IconRefresh, IconX, IconPlus } from './Icons';

const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;

interface Props {
  entry: DocEntry;
  settings: ExportSettings;
  catalog?: CatalogIndex;
  onDocChange: (doc: ParsedDoc) => void;
  onItemChange: (index: number, patch: Partial<ParsedItem>) => void;
  onItemRemove: (index: number) => void;
  onItemAdd: () => void;
  /** Массовая правка строк (пересчёт единиц, × / ÷, единица, вернуть как в накладной) */
  onBulk: (rows: number[], op: BulkOp) => void;
  /** Заменить все строки — для отмены массовой правки */
  onItemsReplace: (items: ParsedItem[]) => void;
  onDelete: () => void;
  onRetry: () => void;
  /** Следующие листы той же таблицы — распознаются и склеиваются с этой накладной */
  onAddPages: (files: File[]) => void;
  /** Отменить распознавание добавляемого листа */
  onCancelPage: (id: string) => void;
  /** Накладные, к которым этот лист можно присоединить */
  joinTargets: DocEntry[];
  onJoin: (targetId: string) => void;
  toast: (text: string) => void;
}

export function DocView({ entry, settings, catalog, onDocChange, onItemChange, onItemRemove, onItemAdd, onBulk, onItemsReplace, onDelete, onRetry, onAddPages, onCancelPage, joinTargets, onJoin, toast }: Props) {
  const pageInput = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<'photo' | 'ocr'>('photo');
  // На узких экранах фото над таблицей; его можно свернуть
  const [photoOpen, setPhotoOpen] = useState(() => window.innerWidth >= 1400);
  const [pageIdx, setPageIdx] = useState(0);
  const doc = entry.doc;
  // Выбор строк для массовых правок; строки добавили или удалили — номера сдвинулись, выбор сбрасываем
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const lastClick = useRef<number>();
  const [undo, setUndo] = useState<ParsedItem[]>();
  const count = doc?.items.length ?? 0;
  useEffect(() => { setSelected(new Set()); setUndo(undefined); }, [count]);

  const toggle = (i: number, range: boolean) => {
    const next = new Set(selected);
    const on = !next.has(i);
    const from = range && lastClick.current !== undefined ? Math.min(lastClick.current, i) : i;
    const to = range && lastClick.current !== undefined ? Math.max(lastClick.current, i) : i;
    for (let k = from; k <= to; k++) { if (on) next.add(k); else next.delete(k); }
    lastClick.current = i;
    setSelected(next);
  };
  const bulk = (rows: number[], op: BulkOp) => {
    if (!doc) return;
    setUndo(doc.items);
    onBulk(rows, op);
  };
  const open = photoOpen || !doc;
  const pages = [{ fileUrl: entry.fileUrl, processedUrl: entry.processedUrl }, ...(entry.extraPages ?? [])];
  const page = pages[Math.min(pageIdx, pages.length - 1)];

  const photo = (
    <section className={`photo ${open ? '' : 'photo--collapsed'}`}>
      <div className="photo__bar">
        {doc && (
          <button type="button" className="btn btn--ghost" onClick={() => setPhotoOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Скрыть фото' : 'Показать фото'}
          </button>
        )}
        <div className="seg" role="tablist">
          <button type="button" role="tab" aria-selected={view === 'photo'} className={view === 'photo' ? 'is-on' : ''} onClick={() => { setView('photo'); setPhotoOpen(true); }}>Фото</button>
          <button type="button" role="tab" aria-selected={view === 'ocr'} className={view === 'ocr' ? 'is-on' : ''} disabled={!page.processedUrl} onClick={() => { setView('ocr'); setPhotoOpen(true); }}>Как видит OCR</button>
        </div>
        {pages.length > 1 && (
          <div className="seg" role="tablist" aria-label="Страницы накладной">
            {pages.map((_, i) => (
              <button key={i} type="button" role="tab" aria-selected={page === pages[i]} className={page === pages[i] ? 'is-on' : ''} onClick={() => { setPageIdx(i); setPhotoOpen(true); }}>
                Стр. {i + 1}
              </button>
            ))}
          </div>
        )}
      </div>
      {open && (
        <div className="photo__view">
          <PhotoViewer src={view === 'ocr' && page.processedUrl ? page.processedUrl : page.fileUrl} alt="Фото накладной" />
        </div>
      )}
    </section>
  );

  if (!doc) {
    return (
      <div className="docview">
        <div className="docview__head">
          <div>
            <h2 className="docview__title">{entry.fileName}</h2>
            {entry.status === 'error' && <p className="err-text">Не удалось распознать: {entry.error}</p>}
            {(entry.status === 'processing' || entry.status === 'queued') && (
              <p className="muted">{entry.status === 'queued' ? 'Ждёт очереди…' : `${entry.stage ?? 'Обработка'} · ${Math.round(entry.progress * 100)}%`}</p>
            )}
          </div>
          <div className="actions">
            {entry.status === 'error' && <button type="button" className="btn" onClick={onRetry}><IconRefresh /> Повторить</button>}
            <button type="button" className="btn btn--ghost" onClick={onDelete}>
              {entry.status === 'error' ? <><IconTrash /> Убрать</> : <><IconX /> Отменить</>}
            </button>
          </div>
        </div>
        <div className="docview__body docview__body--single">{photo}</div>
      </div>
    );
  }

  const s = summarize(doc, catalog);
  const rows = buildRows(doc, settings);
  const dataRows = rows.length - (settings.header ? 1 : 0);
  const merged = mergedLineCount(doc);
  // Общее количество по единицам (как в таблице) и сверка с «Итого» накладной — там количество до пересчёта единиц
  const byUnit = new Map<string, number>();
  for (const it of doc.items) if (it.qty !== undefined) byUnit.set(it.unit ?? '', (byUnit.get(it.unit ?? '') ?? 0) + it.qty);
  const qtyTotals = [...byUnit].map(([unit, qty]) => ({ unit, qty: Math.round(qty * 1000) / 1000 }));
  const origQty = Math.round(doc.items.reduce((a, it) => a + ((it.orig ? it.orig.qty : it.qty) ?? 0), 0) * 1000) / 1000;
  const invoiceQty = doc.totals?.qty;
  const qtyOk = invoiceQty !== undefined && Math.abs(invoiceQty - origQty) < 0.0005;

  const download = () => {
    if (!dataRows) { toast('Нет строк со штрихкодом — нечего выгружать'); return; }
    downloadBlob(toXlsxBlob(rows, settings.columns), exportFileName(doc));
  };
  const toSauda = () => {
    if (!dataRows) { toast('Нет строк со штрихкодом — нечего отправлять'); return; }
    window.open(saudaLink(saudaBase(window.location, saudaOverride()), doc, settings), '_blank', 'noopener');
  };
  const copy = async () => {
    if (!dataRows) { toast('Нет строк со штрихкодом — нечего копировать'); return; }
    const ok = await copyText(toTsv(rows));
    toast(ok ? `Скопировано строк: ${dataRows}. Вставьте через Ctrl+V` : 'Не удалось скопировать');
  };
  const field = (key: 'supplier' | 'number' | 'date', label: string, width?: string) => (
    <label className="field" style={width ? { width } : undefined}>
      <span>{label}</span>
      <input value={doc[key] ?? ''} onChange={(e) => onDocChange({ ...doc, [key]: e.target.value || undefined })} />
    </label>
  );

  const parserIssues = doc.issues.filter((x) => x.kind !== 'totals' && x.level !== 'info');
  const autofilled = doc.items.filter((it) => it.barcodeSource === 'catalog').length;
  const partial = s.total !== undefined && s.sum > 0 && s.total > s.sum * 1.3;
  const pending = entry.pendingPages ?? [];
  const sheetNo = pages.length + 1;
  const addPage = () => pageInput.current?.click();

  return (
    <div className="docview">
      <div className="docview__head">
        <div className="docview__fields">
          {field('supplier', 'Поставщик', 'min(100%, 300px)')}
          {field('number', '№ накладной', '150px')}
          {field('date', 'Дата', '120px')}
          <div className="docview__format muted">{doc.formatName}</div>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={addPage} title="Таблица продолжается на следующем листе — добавьте его фото, строки допишутся сюда">
            <IconPlus /> Добавить лист
          </button>
          <input ref={pageInput} type="file" accept="image/*,application/pdf,.pdf" multiple hidden
            onChange={(e) => { const l = Array.from(e.target.files ?? []); e.target.value = ''; if (l.length) onAddPages(l); }} />
          <button type="button" className="btn btn--primary" onClick={toSauda} title="Открыть Sauda и создать из накладной черновик приёмки">
            В Sauda
          </button>
          <button type="button" className="btn" onClick={download} title="Скачать строки накладной файлом Excel">
            <IconDownload /> Excel
          </button>
          <button type="button" className="btn" onClick={copy} title="Скопировать столбцы в буфер обмена — вставляются через Ctrl+V">
            <IconCopy /> Копировать
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => downloadBlob(toReportBlob([doc]), exportFileName(doc).replace('Sauda_', 'Отчёт_'))} title="Все поля и замечания — для проверки и архива">
            Отчёт
          </button>
          <button type="button" className="icon-btn" onClick={onDelete} title="Убрать накладную" aria-label="Убрать накладную"><IconTrash /></button>
        </div>
      </div>

      <div className="summary">
        <span className="chip">{s.rows} поз.</span>
        {s.errors > 0 && <span className="chip chip--err">{s.errors} с ошибками</span>}
        {s.warnings > 0 && <span className="chip chip--warn">{s.warnings} проверить</span>}
        {s.warnings > 0 && (
          <button type="button" className="chip chip--btn" title="Все жёлтые строки сверены с накладной — снять предупреждения"
            onClick={() => onItemsReplace(approveAll(doc.items, catalog))}>
            <IconCheck /> Всё верно
          </button>
        )}
        <span className={`chip ${s.missingBarcode ? 'chip--warn' : ''}`}>
          В файл: {s.exportable} из {s.rows}{s.missingBarcode ? ` · ${s.missingBarcode} без штрихкода` : ''}
        </span>
        {merged > 0 && (
          <span className="chip" title="Строки с одинаковым штрихкодом (например, бонусные по 1 ₸) и разные штрихкоды одного товара Sauda (вкусы, заведённые дополнительными штрихкодами) складываются в одну: количество суммируется, цена — средняя, штрихкод — основной штрихкод товара">
            Одинаковые товары сложены: {dataRows} строк в файле
          </span>
        )}
      </div>
      {isContinuation(doc) && joinTargets.length > 0 && (
        <div className="join-bar">
          <IconAlert /> Без шапки накладной — похоже на следующий лист другой накладной.
          <select defaultValue="" onChange={(e) => { if (e.target.value) onJoin(e.target.value); }} aria-label="Присоединить к накладной">
            <option value="" disabled>Присоединить к…</option>
            {joinTargets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.doc?.supplier ?? d.fileName}{d.doc?.number ? ` № ${d.doc.number}` : ''} · {d.doc?.items.length} поз.{d.doc?.totals?.sum === undefined ? ' · ждёт лист' : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      {(parserIssues.length > 0 || partial) && (
        <ul className="doc-issues">
          {parserIssues.map((x, i) => <li key={i} className={`row-issue row-issue--${x.level}`}>{x.text}</li>)}
          {partial && (
            <li className="row-issue row-issue--warn">
              Итог накладной намного больше суммы строк — похоже, это не вся накладная. Добавьте остальные листы кнопкой «Добавить лист».
            </li>
          )}
        </ul>
      )}

      <div className="docview__body">
        {photo}
        <section className="items-panel">
          <BulkBar items={doc.items} selected={selected} onSelect={setSelected} rules={settings.unitRules} onBulk={bulk}
            canUndo={!!undo} onUndo={() => { if (undo) { onItemsReplace(undo); setUndo(undefined); } }} />
          <ItemsTable items={doc.items} catalog={catalog} onChange={(i, patch) => { setUndo(undefined); onItemChange(i, patch); }} onRemove={onItemRemove} onAdd={onItemAdd}
            selected={selected} onToggle={toggle} onToggleAll={(on) => setSelected(new Set(on ? doc.items.map((_, i) => i) : []))}
            onScale={(i, field, factor) => bulk([i], { kind: 'scale', field, factor })} />
          <div className="totals-bar">
            <span className="totals-bar__qty" title="Сумма количеств по всем строкам — как они попадут в файл для Sauda">
              Всего: <b>{qtyTotals.map((t) => `${qtyFmt(t.qty)}${t.unit ? ` ${t.unit}` : ''}`).join(' · ') || '0'}</b>
              {invoiceQty !== undefined && (
                <span className={qtyOk ? 'totals-bar__ok' : 'totals-bar__bad'}>
                  {qtyOk ? ' · как в накладной' : ` · в «Итого» накладной прочитано ${qtyFmt(invoiceQty)}, по строкам ${qtyFmt(origQty)} — сверьте`}
                </span>
              )}
            </span>
            {pending.length > 0 ? (
              <span className="chip chip--wait" title="Итог сверится, когда распознаются все добавленные листы">
                <span className="spinner" aria-hidden />
                Ждёт {pending.length > 1 ? `листы ${sheetNo}–${sheetNo + pending.length - 1}` : `лист ${sheetNo}`} · {Math.round(pending[0].progress * 100)}% · пока {money(s.sum)} ₸
                <button type="button" className="chip__x" onClick={() => pending.forEach((p) => onCancelPage(p.id))} title="Не добавлять лист" aria-label="Отменить добавление листа"><IconX /></button>
              </span>
            ) : s.total === undefined ? (
              <span className="chip chip--warn">
                <IconAlert /> Итог не найден · по строкам {money(s.sum)} ₸ ·
                <button type="button" className="chip__link" onClick={addPage} title="Таблица продолжается на следующем листе? Итог обычно на последнем">
                  ждёт лист {sheetNo}? Добавить
                </button>
              </span>
            ) : (
              <span className={`chip ${s.totalsOk ? 'chip--ok' : 'chip--err'}`}>
                {s.totalsOk ? <IconCheck /> : <IconAlert />}
                {s.totalsOk ? `Сходится с итогом: ${money(s.total)} ₸` : `По строкам ${money(s.sum)} ₸, в накладной ${money(s.total)} ₸`}
              </span>
            )}
          </div>
          {autofilled > 0 && (
            <p className="autofill-note">
              <IconAlert /> Штрихкоды в {autofilled} {plural(autofilled, 'строке', 'строках', 'строках')} заполнены или исправлены автоматически
              по каталогу Sauda (такие строки отмечены «автозаполнение» или «исправлен по каталогу»). Возможны ошибки: сверьте товар и нажмите «верно» —
              подтверждённый штрихкод запомнится и в следующий раз подставится без пометки.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
