import { DEFAULT_EXPORT, type ExportSettings, type ExportColumn } from '../core/export';

const KEY = 'umag-ocr.settings.v1';
const ALL: ExportColumn[] = ['barcode', 'qty', 'price', 'name', 'sum', 'code', 'unit'];

export function loadSettings(): ExportSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_EXPORT;
    const s = JSON.parse(raw) as Partial<ExportSettings>;
    const columns = (s.columns ?? DEFAULT_EXPORT.columns).filter((c) => ALL.includes(c));
    return {
      columns: columns.length ? columns : DEFAULT_EXPORT.columns,
      header: s.header ?? DEFAULT_EXPORT.header,
      qtyMode: s.qtyMode === 'packs' ? 'packs' : 'pcs',
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
