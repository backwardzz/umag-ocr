import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { recognizeInvoice, isAbort } from './ocr/engine';
import { parseDocument } from './core/parse';
import { isPdf, pdfToPages } from './ocr/pdf';
import { loadMapping, saveMapping, mapKey, itemMapCode, type MappingStore } from './core/mapping';
import { CatalogIndex, loadCatalog, saveCatalog, type CatalogItem } from './core/catalog';
import { toReportBlob, type ExportSettings } from './core/export';
import { issue, sourceName, type ParsedDoc, type ParsedItem } from './core/types';
import {
  applyCatalog, applyCatalogNames, applyMapping, fillBarcodeByName, applyUnitRules, bulkEdit, docSupplierKey, enrichDoc, findRelated, fixByTotals, isSamePage, attachPage, isContinuation, awaitsSheet, sameTable, newItem, patchItem, ruleFor,
  type BulkOp, type DocEntry,
} from './app/model';
import { loadSettings, saveSettings, downloadBlob } from './app/storage';
import { UploadZone } from './app/UploadZone';
import { DocList } from './app/DocList';
import { DocView } from './app/DocView';
import { SettingsDrawer } from './app/SettingsDrawer';
import { HelpModal } from './app/HelpModal';
import { IconAutoTheme, IconBack, IconBook, IconHelp, IconMoon, IconSettings, IconSun } from './app/Icons';
import { FormatsList, FORMATS_COUNT } from './app/FormatsList';
import { THEME_LABEL, useTheme, type ThemePref } from './app/theme';
import { saudaBase, saudaOverride } from './core/sauda';

const NEXT_THEME: Record<ThemePref, ThemePref> = { auto: 'light', light: 'dark', dark: 'auto' };

let seq = 0;
const newId = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`;

export default function App() {
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [theme, setTheme] = useTheme();
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
        const prepare = (d: ParsedDoc) => fixByTotals(applyUnitRules(enrichDoc(d, mappingRef.current, catalogRef.current), settingsRef.current.unitRules));
        const doc = prepare(res.doc);
        const self = docsRef.current.find((d) => d.id === id);
        let rel = findRelated(docsRef.current, id, doc);
        // Лист-продолжение без шапки, загруженный вместе с первым: если ровно одна накладная ждёт следующий лист
        // и таблица у неё того же вида — он её
        if (!rel && isContinuation(doc)) {
          const waiting = docsRef.current.filter((d) => d.id !== id && awaitsSheet(d) && sameTable(d.doc!, doc));
          if (waiting.length === 1) rel = { kind: 'page', target: waiting[0] };
        }
        if (rel?.kind === 'page' && self) {
          // Вторая страница той же накладной — присоединяем к первой, отдельной карточки не будет
          const page = { fileName: self.fileName, fileUrl: self.fileUrl, processedUrl: res.processedUrl };
          const target = rel.target;
          // лист без шапки — заново разбираем форматом первого листа (разметка столбцов та же)
          const sheet = isContinuation(doc) && target.doc?.supplier ? prepare(parseDocument(res.page, { supplier: target.doc.supplier })) : doc;
          setDocs((prev) => prev.filter((d) => d.id !== id).map((d) => (d.id === target.id ? { ...d, ...attachPage(d, sheet, page) } : d)));
          setSelected((cur) => (cur === id ? target.id : cur));
          files.current.delete(id);
          toast(`«${self.fileName}» — следующая страница накладной${doc.number ? ` № ${doc.number}` : ''}, строки добавлены к ней`);
          return;
        }
        const flagged = rel?.kind === 'duplicate'
          ? { ...doc, issues: [issue('error', `Эта накладная уже загружена («${rel.target.fileName}») — не импортируйте её в Sauda дважды`, 'duplicate'), ...doc.issues] }
          : doc;
        if (rel?.kind === 'duplicate') toast(`«${self?.fileName ?? 'Фото'}» — повтор уже загруженной накладной`);
        update(id, { status: 'done', progress: 1, doc: flagged, processedUrl: res.processedUrl });
      })
      // отменённое фото уже убрано из списка
      .catch((err: unknown) => { if (!isAbort(err)) update(id, { status: 'error', error: err instanceof Error ? err.message : String(err) }); })
      .finally(() => { if (aborts.current.get(id) === ctl) aborts.current.delete(id); });
  }, [update]);

  /**
   * «Добавить лист»: следующий лист той же таблицы (продолжение без шапки, номера и поставщика)
   * распознаётся и склеивается с этой накладной; пока листы распознаются, итог ждёт их
   */
  const addPagesTo = useCallback(async (targetId: string, list: File[]) => {
    const images: File[] = [];
    for (const f of list) {
      if (!isPdf(f)) { images.push(f); continue; }
      try { images.push(...await pdfToPages(f)); } catch (err) {
        toast(`Не удалось открыть «${f.name}»: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const file of images) {
      const pid = newId();
      const ctl = new AbortController();
      aborts.current.set(pid, ctl);
      const setPending = (fn: (p: NonNullable<DocEntry['pendingPages']>) => NonNullable<DocEntry['pendingPages']>) =>
        update(targetId, (d) => ({ pendingPages: fn(d.pendingPages ?? []) }));
      setPending((p) => [...p, { id: pid, fileName: file.name, progress: 0 }]);
      const fileUrl = URL.createObjectURL(file);
      // лист без шапки разбирается форматом первого листа
      const hint = { supplier: docsRef.current.find((d) => d.id === targetId)?.doc?.supplier };
      recognizeInvoice(file, (stage, p) => setPending((all) => all.map((x) => (x.id === pid ? { ...x, stage, progress: p } : x))), ctl.signal, hint)
        .then((res) => {
          if (ctl.signal.aborted) return;
          const page = applyUnitRules(enrichDoc(res.doc, mappingRef.current, catalogRef.current), settingsRef.current.unitRules);
          const target = docsRef.current.find((d) => d.id === targetId);
          if (!target?.doc) return;
          if (!page.items.length) { toast(`«${file.name}»: строки таблицы не найдены — лист не добавлен`); return; }
          if (isSamePage(target.doc, page)) { toast(`«${file.name}» — этот лист уже есть в накладной`); return; }
          update(targetId, (d) => attachPage(d, page, { fileName: file.name, fileUrl, processedUrl: res.processedUrl }));
          toast(`«${file.name}»: добавлено строк — ${page.items.length}`);
        })
        .catch((err: unknown) => { if (!isAbort(err)) toast(`«${file.name}» не распознан: ${err instanceof Error ? err.message : String(err)}`); })
        .finally(() => {
          setPending((p) => p.filter((x) => x.id !== pid));
          if (aborts.current.get(pid) === ctl) aborts.current.delete(pid);
        });
    }
  }, [update, toast]);

  /** Накладную src (лист, загруженный отдельно) присоединить к накладной target как её лист */
  const joinTo = (srcId: string, targetId: string) => {
    const src = docsRef.current.find((d) => d.id === srcId);
    if (!src?.doc) return;
    const photos = [{ fileName: src.fileName, fileUrl: src.fileUrl, processedUrl: src.processedUrl }, ...(src.extraPages ?? [])];
    setDocs((prev) => prev.filter((d) => d.id !== srcId).map((d) => (d.id === targetId ? { ...d, ...attachPage(d, src.doc!, ...photos) } : d)));
    setSelected(targetId);
    files.current.delete(srcId);
    toast(`Строки «${src.fileName}» добавлены к накладной`);
  };

  /** Отменить распознавание добавляемого листа */
  const cancelPage = (pid: string) => { aborts.current.get(pid)?.abort(); };

  const addImages = useCallback((list: File[]) => {
    const entries: DocEntry[] = list.map((f) => {
      const id = newId();
      files.current.set(id, f);
      return { id, fileName: f.name, fileUrl: URL.createObjectURL(f), status: 'queued', progress: 0 };
    });
    setDocs((prev) => [...prev, ...entries]);
    setSelected((cur) => cur ?? entries[0]?.id);
    entries.forEach((e) => process(e.id));
  }, [process]);

  /** Фото — сразу в очередь; PDF сначала раскладывается на страницы (каждая страница — как фото) */
  const addFiles = useCallback(async (list: File[]) => {
    for (const f of list) {
      if (!isPdf(f)) { addImages([f]); continue; }
      toast(`Открываю «${f.name}»…`);
      try {
        const pages = await pdfToPages(f);
        addImages(pages);
        if (pages.length > 1) toast(`«${f.name}»: ${pages.length} стр. — страницы одной накладной склеятся сами`);
      } catch (err) {
        toast(`Не удалось открыть «${f.name}»: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, [addImages, toast]);

  // Режим разработки: ?demo загружает примеры из samples/ (в сборку не попадают)
  useEffect(() => {
    const w = window as unknown as { __demoLoaded?: boolean };
    // StrictMode и горячая перезагрузка вызывают эффект повторно
    if (!import.meta.env.DEV || w.__demoLoaded || !new URLSearchParams(location.search).has('demo')) return;
    w.__demoLoaded = true;
    const names = (new URLSearchParams(location.search).get('demo') || '1,2,3').split(',');
    Promise.all(names.map(async (n) => {
      // «eurasian_3427.pdf» — как есть, без расширения — фото .jpg
      const name = n.includes('.') ? n : `${n}.jpg`;
      const r = await fetch(`/samples/${name}`);
      return new File([await r.blob()], name, { type: name.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg' });
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
    // Ввели название у строки без штрихкода (например, добавленной вручную) — штрихкод ищется в каталоге по названию
    changeDoc(current.id, (d) => applyCatalogNames({
      ...d,
      items: d.items.map((it, i) => {
        if (i !== index) return it;
        const next = patchItem(it, patch);
        return 'name' in patch ? fillBarcodeByName(next, d, catalogRef.current) : next;
      }),
    }, catalogRef.current));
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
    docsRef.current.find((d) => d.id === id)?.pendingPages?.forEach((p) => aborts.current.get(p.id)?.abort());
    setDocs((prev) => {
      const next = prev.filter((d) => d.id !== id);
      if (selected === id) setSelected(next[0]?.id);
      return next;
    });
    files.current.delete(id);
  };

  const doneDocs = docs.filter((d) => d.doc).map((d) => d.doc!);
  const saudaDocs = `${saudaBase(window.location, saudaOverride())}#/docs/supply`;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={saudaDocs} title="Вернуться в Sauda — к приёмкам">
          <span className="brand__mark" aria-hidden>S</span>
          Sauda
          <span className="brand__section">Накладные</span>
        </a>
        <nav className="topbar__nav">
          <button type="button" className="btn btn--ghost" onClick={() => setHelp(true)} aria-label="Как загрузить в Sauda" title="Как загрузить в Sauda"><IconHelp /> <span className="hide-sm">Как загрузить в Sauda</span></button>
          <button type="button" className="btn btn--ghost" onClick={() => setDrawer({ open: true, tab: 'mapping' })} aria-label="Справочник кодов" title="Справочник кодов"><IconBook /> <span className="hide-sm">Справочник</span></button>
          <button type="button" className="btn btn--ghost" onClick={() => setDrawer({ open: true, tab: 'export' })} aria-label="Настройки" title="Настройки"><IconSettings /> <span className="hide-sm">Настройки</span></button>
        </nav>
        <div className="topbar__end">
          {doneDocs.length > 1 && (
            <button type="button" className="btn btn--ghost" onClick={() => downloadBlob(toReportBlob(doneDocs), 'Отчёт_по_накладным.xlsx')}>
              Отчёт по всем
            </button>
          )}
          <button type="button" className="icon-btn" onClick={() => setTheme(NEXT_THEME[theme])}
            title={`Тема: ${THEME_LABEL[theme]}. Нажмите — ${THEME_LABEL[NEXT_THEME[theme]].toLowerCase()}`} aria-label={`Тема: ${THEME_LABEL[theme]}`}>
            {theme === 'dark' ? <IconMoon /> : theme === 'light' ? <IconSun /> : <IconAutoTheme />}
          </button>
          <a className="btn btn--ghost" href={saudaDocs} title="Вернуться в Sauda — к приёмкам"><IconBack /> <span className="hide-sm">Приёмки в Sauda</span></a>
        </div>
      </header>

      {docs.length === 0 ? (
        <main className="empty">
          <h1>Фото или PDF накладной → приёмка в Sauda</h1>
          <p className="muted">Распознавание работает прямо в браузере, фото и PDF никуда не отправляются.</p>
          <UploadZone onFiles={addFiles} />
          <ol className="empty__steps">
            <li><b>Сфотографируйте</b> накладную или выберите готовые фото или PDF</li>
            <li><b>Проверьте</b> строки, отмеченные жёлтым или красным</li>
            <li><b>Нажмите «В Sauda»</b> — там создаётся черновик приёмки, останется его провести</li>
          </ol>
          <details className="formats-box">
            <summary>Какие накладные принимает система · {FORMATS_COUNT} поставщиков</summary>
            <FormatsList />
            <p className="muted small">Многостраничную накладную загрузите всеми фото — листы склеятся сами. Или откройте первый лист и нажмите «Добавить лист».</p>
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
                onAddPages={(list) => addPagesTo(current.id, list)}
                onCancelPage={cancelPage}
                joinTargets={docs.filter((d) => d.id !== current.id && d.doc && !isContinuation(d.doc))}
                onJoin={(targetId) => joinTo(current.id, targetId)}
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
