import { useEffect, useState } from 'react';

/**
 * Тема оформления: «авто» — как в системе, или явно светлая/тёмная. Выбор хранится в localStorage
 * под ключом sauda.theme — его же читает сайт Sauda (тот же адрес сайта, см. src/lib/theme.ts в проекте Sauda),
 * поэтому тема в обоих совпадает. До запуска React тему ставит скрипт в index.html, чтобы не мигало.
 */
export type ThemePref = 'auto' | 'light' | 'dark';

const KEY = 'sauda.theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(pref: ThemePref = themePref()): void {
  const dark = pref === 'dark' || (pref === 'auto' && media().matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/** Вызывается один раз при запуске: следит за темой системы и за выбором в других вкладках. */
export function watchTheme(): void {
  applyTheme();
  media().addEventListener('change', () => applyTheme());
  window.addEventListener('storage', (e) => { if (e.key === KEY) applyTheme(); });
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState(themePref);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) setPref(themePref()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const set = (p: ThemePref) => {
    try {
      if (p === 'auto') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, p);
    } catch { /* приватный режим: тема держится до перезагрузки */ }
    setPref(p);
    applyTheme(p);
  };
  return [pref, set];
}

export const THEME_LABEL: Record<ThemePref, string> = { auto: 'Как в системе', light: 'Светлая', dark: 'Тёмная' };
