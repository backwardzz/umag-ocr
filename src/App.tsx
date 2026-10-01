import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { recognizeInvoice, isAbort } from './ocr/engine';
import { loadMapping, saveMapping, mapKey, itemMapCode, type MappingStore } from './core/mapping';
import { CatalogIndex, loadCatalog, saveCatalog, type CatalogItem } from './core/catalog';
import { toReportBlob, type ExportSettings } from './core/export';
import { issue, sourceName, type ParsedDoc, type ParsedItem } from './core/types';
import {
  applyCatalog, applyCatalogNames, applyMapping, applyUnitRules, bulkEdit, docSupplierKey, enrichDoc, findRelated, mergePages, newItem, patchItem, ruleFor,
  type BulkOp, type DocEntry,
} from './app/model';
import { loadSettings, saveSettings, downloadBlob } from './app/storage';
import { UploadZone } from './app/UploadZone';
import { DocList } from './app/DocList';
import { DocView } from './app/DocView';
import { SettingsDrawer } from './app/SettingsDrawer';
import { HelpModal } from './app/HelpModal';
import { IconBook, IconHelp, IconSettings } from './app/Icons';
import { FormatsList, FORMATS_COUNT } from './app/FormatsList';

let seq = 0;
const newId = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`;

export default function App() {
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [selected, setSelected] = useState<string>();
  const [settings, setSettingsState] = useState<ExportSettings>(loadSettings);
  const [mapping, setMappingState] = useState<MappingStore>(loadMapping);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>(loadCatalog);
  const [drawer, setDrawer] = useState<{ open: boolean; tab: 'export' | 'catalog' | 'mapping' }>({ open: false, tab: 'export' });
  const [help, setHelp] = useState(false);
  const [toastText, setToastText] = useState<string>();
  const files = useRef(new Map<string, File>());
  /** Отмена распознавания по id фото (в очереди или в работе) */
  const aborts = useRef(new Map<string, AbortController>());
  const mappingRef = useRef(mapping);
  mappingRef.current = mapping;
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const catalog = useMemo(() => (catalogItems.length ? new CatalogIndex(catalogItems) : undefined), [catalogItems]);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  // Каталог загрузили, заменили или очистили — пересчитываем автозаполнение и названия во всех накладных
  const firstCatalog = useRef(true);
  useEffect(() => {
    if (firstCatalog.current) { firstCatalog.current = false; return; }
    setDocs((prev) => prev.map((d) => (d.doc ? { ...d, doc: applyCatalogNames(applyCatalog(d.doc, catalog), catalog) } : d)));
  }, [catalog]);

  const toast = useCallback((t: string) => {
    setToastText(t);
    window.setTimeout(() => setToastText((cur) => (cur === t ? undefined : cur)), 4500);
  }, []);

  const update = useCallback((id: string, patch: Partial<DocEntry> | ((d: DocEntry) => Partial<DocEntry>)) => {
    setDocs((prev) => prev.map((d) => (d.id === id ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch) } : d)));
  }, []);

  const process = useCallback((id: string) => {
    const file = files.current.get(id);
    if (!file) return;
    update(id, { status: 'queued', progress: 0, error: undefined });
    const ctl = new AbortController();
    aborts.current.set(id, ctl);
    let last = -1;
    recognizeInvoice(file, (stage, p) => {
      const pct = Math.round(p * 100);
      if (pct === last) return;
      last = pct;
      update(id, { status: 'processing', stage, progress: p });
    }, ctl.signal)
      .then((res) => {
        if (ctl.signal.aborted) return;
        // Сначала справочник (штрихкоды, подтверждённые пользователем), затем автозаполнение из каталога,
        // затем названия из каталога по найденным штрихкодам; в конце — пересчёт единиц (1 блок = 10 шт)
        const doc = applyUnitRules(enrichDoc(res.doc, mappingRef.current, catalogRef.current), settingsRef.current.unitRules);
        const self = docsRef.current.find((d) => d.id === id);
        const rel = findRelated(docsRef.current, id, doc);
        if (rel?.kind === 'page' && self) {
          // Вторая страница той же накладной — присоединяем к первой, отдельной карточки не будет
          const page = { fileName: self.fileName, fileUrl: self.fileUrl, processedUrl: res.processedUrl };
          setDocs((prev) => prev.filter((d) => d.id !== id).map((d) => (d.id === rel.target.id && d.doc
            ? { ...d, doc: mergePages(d.doc, doc), extraPages: [...(d.extraPages ?? []), page] }
            : d)));
          setSelected((cur) => (cur === id ? rel.target.id : cur));
          files.current.delete(id);
          toast(`«${self.fileName}» — следующая страница накладной${doc.number ? ` № ${doc.number}` : ''}, строки добавлены к ней`);
          return;
        }
        const flagged = rel?.kind === 'duplicate'
          ? { ...doc, issues: [issue('error', `Эта накладная уже загружена («${rel.target.fileName}») — не импортируйте её в UMAG дважды`, 'duplicate'), ...doc.issues] }
          : doc;
        if (rel?.kind === 'duplicate') toast(`«${self?.fileName ?? 'Фото'}» — повтор уже загруженной накладной`);
        update(id, { status: 'done', progress: 1, doc: flagged, processedUrl: res.processedUrl });
      })
      // отменённое фото уже убрано из списка
      .catch((err: unknown) => { if (!isAbort(err)) update(id, { status: 'error', error: err instanceof Error ? err.message : String(err) }); })
      .finally(() => { if (aborts.current.get(id) === ctl) aborts.current.delete(id); });
  }, [update]);

  const addFiles = useCallback((list: File[]) => {
    const entries: DocEntry[] = list.map((f) => {
      const id = newId();
      files.current.set(id, f);
      return { id, fileName: f.name, fileUrl: URL.createObjectURL(f), status: 'queued', progress: 0 };
    });
    setDocs((prev) => [...prev, ...entries]);
    setSelected((cur) => cur ?? entries[0]?.id);
    entries.forEach((e) => process(e.id));
  }, [process]);

  // Режим разработки: ?demo загружает примеры из samples/ (в сборку не попадают)
  useEffect(() => {
    const w = window as unknown as { __demoLoaded?: boolean };
    // StrictMode и горячая перезагрузка вызывают эффект повторно
    if (!import.meta.env.DEV || w.__demoLoaded || !new URLSearchParams(location.search).has('demo')) return;
    w.__demoLoaded = true;
    const names = (new URLSearchParams(location.search).get('demo') || '1,2,3').split(',');
    Promise.all(names.map(async (n) => {
      const r = await fetch(`/samples/${n}.jpg`);
      return new File([await r.blob()], `${n}.jpg`, { type: 'image/jpeg' });
    })).then(addFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Предупреждение при закрытии вкладки, если есть распознанные накладные
  useEffect(() => {
    if (!docs.length) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [docs.length]);

  const setSettings = (s: ExportSettings) => { setSettingsState(s); saveSettings(s); };
  const setMapping = (m: MappingStore) => {
    setMappingState(m);
    if (!saveMapping(m)) toast('Не удалось сохранить справочник в браузере (приватный режим?) — сохраните его в файл');
  };
  const setCatalog = (items: CatalogItem[]) => {
    setCatalogItems(items);
    if (!saveCatalog(items)) toast('Каталог слишком большой для хранения в браузере — он будет работать до перезагрузки страницы');
  };

  const current = docs.find((d) => d.id === selected);

  const changeDoc = (id: string, fn: (doc: ParsedDoc) => ParsedDoc) =>
    update(id, (d) => (d.doc ? { doc: fn(d.doc) } : {}));

  const onItemChange = (index: number, patch: Partial<ParsedItem>) => {
    if (!current?.doc) return;
    const doc = current.doc;
    const item = doc.items[index];
    // Новый штрихкод есть в каталоге — название сразу подтягивается из него
    changeDoc(current.id, (d) => applyCatalogNames({ ...d, items: d.items.map((it, i) => (i === index ? patchItem(it, patch) : it)) }, catalogRef.current));
    // Штрихкод для кода поставщика (или названия, если кодов нет) — запоминаем
    // и подставляем в другие открытые накладные
    const code = itemMapCode(item);
    if ('barcode' in patch && patch.barcode && code && item.barcodeSource !== 'invoice') {
      const sk = docSupplierKey(doc);
      const m: MappingStore = {
        ...mappingRef.current,
        // название из накладной: с ним сравниваются строки следующих накладных
        [mapKey(sk, code)]: { barcode: patch.barcode, name: sourceName(item), supplier: doc.supplier, updated: new Date().toISOString() },
      };
      setMapping(m);
      setDocs((prev) => prev.map((d) => (d.doc && d.id !== current.id && docSupplierKey(d.doc) === sk
        ? { ...d, doc: applyCatalogNames(applyMapping(d.doc, m), catalogRef.current) } : d)));
      toast(item.code ? `Запомнено: код ${item.code} → ${patch.barcode}` : `Запомнено: «${sourceName(item)}» → ${patch.barcode}`);
    }
  };

  const onBulk = (rows: number[], op: BulkOp) => {
    if (current?.doc) changeDoc(current.id, (d) => ({ ...d, items: bulkEdit(d.items, rows, op) }));
  };

  /** Правила пересчёта единиц поменяли в настройках — применяем и к уже открытым накладным */
  const applyRulesToOpen = () => {
    const rules = settingsRef.current.unitRules;
    const n = docsRef.current.reduce((acc, d) => acc + (d.doc?.items.filter((it) => !it.orig && it.qty !== undefined && ruleFor(it.unit, rules)).length ?? 0), 0);
    setDocs((prev) => prev.map((d) => (d.doc ? { ...d, doc: applyUnitRules(d.doc, rules) } : d)));
    toast(n ? `Пересчитано строк: ${n}` : 'В открытых накладных нет строк для пересчёта');
  };

  /** Убрать фото; если оно ещё распознаётся или ждёт очереди — распознавание отменяется */
  const onDelete = (id: string) => {
    aborts.current.get(id)?.abort();
    aborts.current.delete(id);
    setDocs((prev) => {
      const next = prev.filter((d) => d.id !== id);
      if (selected === id) setSelected(next[0]?.id);
      return next;
    });
    files.current.delete(id);
  };

  const doneDocs = docs.filter((d) => d.doc).map((d) => d.doc!);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden>≡</span>
          <span className="brand__name">Накладные <span className="brand__arrow">→</span> UMAG</span>
        </div>
        <nav className="topbar__nav">
          {doneDocs.length > 1 && (
            <button type="button" className="btn btn--ghost" onClick={() => downloadBlob(toReportBlob(doneDocs), 'Отчёт_по_накладным.xlsx')}>
              Отчёт по всем
            </button>
          )}
          <button type="button" className="btn btn--ghost" onClick={() => setHelp(true)} aria-label="Как загрузить в UMAG" title="Как загрузить в UMAG"><IconHelp /> <span className="hide-sm">Как загрузить в UMAG</span></button>
          <button type="button" className="btn btn--ghost" onClick={() => setDrawer({ open: true, tab: 'mapping' })} aria-label="Справочник кодов" title="Справочник кодов"><IconBook /> <span className="hide-sm">Справочник</span></button>
          <button type="button" className="btn btn--ghost" onClick={() => setDrawer({ open: true, tab: 'export' })} aria-label="Настройки" title="Настройки"><IconSettings /> <span className="hide-sm">Настройки</span></button>
        </nav>
      </header>

      {docs.length === 0 ? (
        <main className="empty">
          <h1>Фото накладной → Excel для UMAG</h1>
          <p className="muted">Распознавание работает прямо в браузере, фото никуда не отправляются.</p>
          <UploadZone onFiles={addFiles} />
          <ol className="empty__steps">
            <li><b>Сфотографируйте</b> накладную или выберите готовые фото</li>
            <li><b>Проверьте</b> строки, отмеченные жёлтым или красным</li>
            <li><b>Скачайте Excel</b> и загрузите его в UMAG: «Приёмка» → «Импорт товаров»</li>
          </ol>
          <details className="formats-box">
            <summary>Какие накладные принимает система · {FORMATS_COUNT} поставщиков</summary>
            <FormatsList />
            <p className="muted small">Многостраничную накладную загрузите всеми фото — страницы склеятся сами.</p>
          </details>
        </main>
      ) : (
        <div className="layout">
          <aside className="sidebar">
            <UploadZone onFiles={addFiles} compact />
            <DocList docs={docs} selected={selected} catalog={catalog} onSelect={setSelected} onCancel={onDelete} />
          </aside>
          <main className="main">
            {current ? (
              <DocView
                key={current.id}
                entry={current}
                settings={settings}
                catalog={catalog}
                onDocChange={(doc) => changeDoc(current.id, () => doc)}
                onItemChange={onItemChange}
                onItemRemove={(i) => changeDoc(current.id, (d) => ({ ...d, items: d.items.filter((_, k) => k !== i) }))}
                onItemAdd={() => changeDoc(current.id, (d) => ({ ...d, items: [...d.items, newItem(d.items.length + 1)] }))}
                onBulk={onBulk}
                onItemsReplace={(items) => changeDoc(current.id, (d) => ({ ...d, items }))}
                onDelete={() => onDelete(current.id)}
                onRetry={() => process(current.id)}
                toast={toast}
              />
            ) : (
              <p className="muted pad">Выберите накладную слева</p>
            )}
          </main>
        </div>
      )}

      <SettingsDrawer
        open={drawer.open}
        tab={drawer.tab}
        onTab={(tab) => setDrawer({ open: true, tab })}
        onClose={() => setDrawer((d) => ({ ...d, open: false }))}
        settings={settings}
        onSettings={setSettings}
        onApplyRules={applyRulesToOpen}
        catalogSize={catalogItems.length}
        onCatalog={setCatalog}
        mapping={mapping}
        onMapping={setMapping}
        toast={toast}
      />
      <HelpModal open={help} onClose={() => setHelp(false)} />
      {toastText && <div className="toast" role="status">{toastText}</div>}
    </div>
  );
}
