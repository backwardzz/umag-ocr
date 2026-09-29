import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Только для разработки: POST /__save-ocr?name=1-browser сохраняет результат OCR
 * из браузера в samples/<name>.ocr.json — он становится тестовым примером (npm test).
 */
function saveOcrFixtures(): Plugin {
  return {
    name: 'save-ocr-fixtures',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save-ocr', (req, res) => {
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
        if (req.method !== 'POST' || !/^[\w-]+$/.test(name)) {
          res.statusCode = 400;
          res.end('bad request');
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          fs.writeFileSync(path.join(server.config.root, 'samples', `${name}.ocr.json`), body);
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  // Относительные пути — сборку можно открыть с любого адреса/подпапки (GitHub Pages и т.п.)
  base: './',
  plugins: [react(), saveOcrFixtures()],
  worker: { format: 'es' },
  server: { port: 5178 },
});
