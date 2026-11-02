/**
 * Приложение для Android (Capacitor): тот же сайт внутри WebView. Отличия от браузера —
 * файлы (Excel, отчёт, справочник) не скачиваются, а отдаются в меню «Поделиться»
 * (сохранить, отправить в WhatsApp/Telegram), а ссылки открываются в браузере телефона.
 * Плагины загружаются только в приложении — в сборку сайта они не попадают.
 */
import { Capacitor } from '@capacitor/core';

export const isNative = () => Capacitor.isNativePlatform();

/** Опубликованная Sauda: в приложении сайт открыт на localhost, рядом с ним Sauda нет */
export const SAUDA_PUBLIC = 'https://backwardzz.github.io/sauda/';

const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/** Файл — во временную папку приложения и в меню «Поделиться» */
export async function shareFile(blob: Blob, name: string): Promise<void> {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
  const { uri } = await Filesystem.writeFile({ path: name, data: await toBase64(blob), directory: Directory.Cache, recursive: true });
  await Share.share({ title: name, files: [uri], dialogTitle: 'Сохранить или отправить файл' });
}

/** Ссылка — в браузере телефона (Sauda открывается там, где пользователь вошёл в неё) */
export async function openExternal(url: string): Promise<void> {
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url });
}
