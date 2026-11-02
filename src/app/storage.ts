import { DEFAULT_EXPORT, type ExportSettings, type ExportColumn } from '../core/export';
import { isNative, shareFile } from './native';

const KEY = 'umag-ocr.settings.v1';
const ALL: ExportColumn[] = ['barcode', 'qty', 'name', 'unit', 'price', 'sum', 'code'];
/** Прежние наборы по умолчанию: сохранённые с ними настройки переводим на новый (пятый столбец — цена приходная) */
const OLD_DEFAULTS = ['barcode,qty,price', 'barcode,qty,name,unit'];

export function loadSettings(): ExportSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_EXPORT;
    const s = JSON.parse(raw) as Partial<ExportSettings>;
    const saved = OLD_DEFAULTS.includes(s.columns?.join(',') ?? '') ? undefined : s.columns;
    const columns = (saved ?? DEFAULT_EXPORT.columns).filter((c) => ALL.includes(c));
    return {
      columns: columns.length ? columns : DEFAULT_EXPORT.columns,
      header: s.header ?? DEFAULT_EXPORT.header,
      qtyMode: s.qtyMode === 'packs' ? 'packs' : 'pcs',
      // сохранённые до появления правил настройки получают правило по умолчанию (1 блок = 10 шт)
      unitRules: Array.isArray(s.unitRules)
        ? s.unitRules.filter((r) => r && typeof r.from === 'string' && typeof r.to === 'string' && Number(r.factor) > 0)
          .map((r) => ({ from: r.from, to: r.to, factor: Number(r.factor) }))
        : DEFAULT_EXPORT.unitRules,
    };
  } catch {
    return DEFAULT_EXPORT;
  }
}

export function saveSettings(s: ExportSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* приватный режим — настройки просто не запомнятся */
  }
}

export function downloadBlob(blob: Blob, name: string) {
  // в приложении для Android скачивание из WebView не работает — файл уходит в «Поделиться»
  if (isNative()) {
    shareFile(blob, name).catch((err: unknown) => {
      // пользователь закрыл меню «Поделиться» — это не ошибка
      if (!/cancel/i.test(String(err))) alert(`Не удалось сохранить «${name}»: ${err instanceof Error ? err.message : String(err)}`);
    });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Фолбэк для http без clipboard API
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export { ALL as ALL_COLUMNS };
