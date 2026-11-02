import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Приложение для Android: собранный сайт (dist) внутри WebView, распознавание — на телефоне, без интернета.
 *   npm run apk   — сборка сайта, копирование в android/ и сборка APK (android/app/build/outputs/apk/)
 */
const config: CapacitorConfig = {
  appId: 'io.github.backwardzz.nakladnye',
  appName: 'Накладные Sauda',
  webDir: 'dist',
  android: {
    // фото накладных и каталог открываются через выбор файла — WebView нужен доступ к ним
    allowMixedContent: false,
  },
};

export default config;
