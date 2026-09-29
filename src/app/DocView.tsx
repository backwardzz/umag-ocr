import { useState } from 'react';
import type { CatalogIndex } from '../core/catalog';
import type { ParsedDoc, ParsedItem } from '../core/types';
import { buildRows, exportFileName, toTsv, toXlsxBlob, toReportBlob, type ExportSettings } from '../core/export';
import { summarize, money, type DocEntry } from './model';
import { ItemsTable } from './ItemsTable';
import { downloadBlob, copyText } from './storage';
import { IconCopy, IconDownload, IconTrash, IconAlert, IconCheck, IconRefresh } from './Icons';

interface Props {
  entry: DocEntry;
  settings: ExportSettings;
  catalog?: CatalogIndex;
  onDocChange: (doc: ParsedDoc) => void;
  onItemChange: (index: number, patch: Partial<ParsedItem>) => void;
  onItemRemove: (index: number) => void;
  onItemAdd: () => void;
  onDelete: () => void;
  onRetry: () => void;
  toast: (text: string) => void;
}

export function DocView({ entry, settings, catalog, onDocChange, onItemChange, onItemRemove, onItemAdd, onDelete, onRetry, toast }: Props) {
  const [view, setView] = useState<'photo' | 'ocr'>('photo');
  const [zoom, setZoom] = useState(1);
  // На узких экранах фото над таблицей; его можно свернуть
  const [photoOpen, setPhotoOpen] = useState(() => window.innerWidth >= 1400);
  const doc = entry.doc;
  const open = photoOpen || !doc;

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
          <button type="button" role="tab" aria-selected={view === 'ocr'} className={view === 'ocr' ? 'is-on' : ''} disabled={!entry.processedUrl} onClick={() => { setView('ocr'); setPhotoOpen(true); }}>Как видит OCR</button>
        </div>
        {open && <div className="seg">
          <button type="button" onClick={() => setZoom((z) => Math.max(1, z / 1.5))} aria-label="Уменьшить">−</button>
          <button type="button" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" onClick={() => setZoom((z) => Math.min(6, z * 1.5))} aria-label="Увеличить">+</button>
        </div>}
      </div>
      <div className="photo__view">
        <img src={view === 'ocr' && entry.processedUrl ? entry.processedUrl : entry.fileUrl} alt="Фото накладной" style={{ width: `${zoom * 100}%` }} />
      </div>
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
            <button type="button" className="btn btn--ghost" onClick={onDelete}><IconTrash /> Убрать</button>
          </div>
        </div>
        <div className="docview__body docview__body--single">{photo}</div>
      </div>
    );
  }

  const s = summarize(doc, catalog);
  const rows = buildRows(doc, settings);
  const dataRows = rows.length - (settings.header ? 1 : 0);

  const download = () => {
    if (!dataRows) { toast('Нет строк со штрихкодом — нечего выгружать'); return; }
    downloadBlob(toXlsxBlob(rows, settings.columns), exportFileName(doc));
  };
  const copy = async () => {
    if (!dataRows) { toast('Нет строк со штрихкодом — нечего копировать'); return; }
    const ok = await copyText(toTsv(rows));
    toast(ok ? `Скопировано строк: ${dataRows}. В UMAG: «Импорт товаров» → Ctrl+V → «Табуляция»` : 'Не удалось скопировать');
  };
  const field = (key: 'supplier' | 'number' | 'date', label: string, width?: string) => (
    <label className="field" style={width ? { width } : undefined}>
      <span>{label}</span>
      <input value={doc[key] ?? ''} onChange={(e) => onDocChange({ ...doc, [key]: e.target.value || undefined })} />
    </label>
  );

  const parserIssues = doc.issues.filter((x) => x.kind !== 'totals' && x.level !== 'info');

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
          <button type="button" className="btn btn--primary" onClick={download} title="Файл для «Приёмка → Импорт товаров» в UMAG">
            <IconDownload /> Excel для UMAG
          </button>
          <button type="button" className="btn" onClick={copy} title="Скопировать столбцы и вставить в окно импорта UMAG через Ctrl+V">
            <IconCopy /> Копировать
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => downloadBlob(toReportBlob([doc]), exportFileName(doc).replace('UMAG_', 'Отчёт_'))} title="Все поля и замечания — для проверки и архива">
            Отчёт
          </button>
          <button type="button" className="icon-btn" onClick={onDelete} title="Убрать накладную" aria-label="Убрать накладную"><IconTrash /></button>
        </div>
      </div>

      <div className="summary">
        <span className={`chip ${s.totalsOk === false ? 'chip--err' : s.totalsOk ? 'chip--ok' : 'chip--warn'}`}>
          {s.totalsOk ? <IconCheck /> : <IconAlert />}
          {s.total === undefined
            ? `Итог не прочитан · по строкам ${money(s.sum)} ₸`
            : s.totalsOk
              ? `Сходится с итогом: ${money(s.total)} ₸`
              : `По строкам ${money(s.sum)} ₸, в накладной ${money(s.total)} ₸`}
        </span>
        <span className="chip">{s.rows} поз.</span>
        {s.errors > 0 && <span className="chip chip--err">{s.errors} с ошибками</span>}
        {s.warnings > 0 && <span className="chip chip--warn">{s.warnings} проверить</span>}
        <span className={`chip ${s.missingBarcode ? 'chip--warn' : ''}`}>
          В файл: {s.exportable} из {s.rows}{s.missingBarcode ? ` · ${s.missingBarcode} без штрихкода` : ''}
        </span>
      </div>
      {parserIssues.length > 0 && (
        <ul className="doc-issues">
          {parserIssues.map((x, i) => <li key={i} className={`row-issue row-issue--${x.level}`}>{x.text}</li>)}
        </ul>
      )}

      <div className="docview__body">
        {photo}
        <section className="items-panel">
          <ItemsTable items={doc.items} catalog={catalog} onChange={onItemChange} onRemove={onItemRemove} onAdd={onItemAdd} />
        </section>
      </div>
    </div>
  );
}
