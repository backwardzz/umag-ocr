/**
 * PDF → картинки страниц. Накладную в PDF (скан или выгрузка из 1С) раскладываем по страницам,
 * каждая страница идёт в тот же конвейер, что и фото; страницы одной накладной потом склеиваются.
 * pdf.js подгружается только когда выбран PDF — в основной бандл не входит.
 */

/** Длинная сторона страницы в пикселях: как у фото после уменьшения (см. MAX_SIDE в engine.ts) */
const PAGE_SIDE = 3200;
/** Больше страниц — скорее всего не накладная (и распознавание займёт слишком долго) */
export const MAX_PDF_PAGES = 30;

export const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

/**
 * Длинная сторона картинки-скана в пикселях, если страница состоит из одной картинки
 * (текста на странице при этом может не быть вовсе или это невидимый слой распознавания).
 */
async function scanImageSide(page: { getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }> }, paintImage: number): Promise<number | undefined> {
  const ops = await page.getOperatorList();
  const images = ops.fnArray
    .map((fn, i) => (fn === paintImage ? (ops.argsArray[i] as unknown[]) : undefined))
    .filter((a): a is unknown[] => !!a && typeof a[1] === 'number' && typeof a[2] === 'number')
    .map((a) => Math.max(a[1] as number, a[2] as number));
  return images.length === 1 && images[0] >= 800 ? images[0] : undefined;
}

export async function pdfToPages(file: File): Promise<File[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const assets = new URL(`${import.meta.env.BASE_URL}pdfjs/`, location.href).toString();
  const task = pdfjs.getDocument({
    data: await file.arrayBuffer(),
    // шрифты и кодировки, не встроенные в PDF (иначе кириллица в таких файлах рисуется квадратиками)
    cMapUrl: `${assets}cmaps/`, cMapPacked: true, standardFontDataUrl: `${assets}standard_fonts/`,
  });
  const doc = await task.promise;
  try {
    if (doc.numPages > MAX_PDF_PAGES) throw new Error(`в файле ${doc.numPages} страниц — больше ${MAX_PDF_PAGES} не открываю`);
    const base = file.name.replace(/\.pdf$/i, '');
    const pages: File[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const size = page.getViewport({ scale: 1 });
      // Скан: страница — одна большая картинка. Рисуем её в родном разрешении: растянутый скан
      // распознаётся хуже исходного фото. Выгрузка из программы (текст) — в полном размере.
      const scanSide = await scanImageSide(page, pdfjs.OPS.paintImageXObject);
      const side = scanSide ? Math.min(PAGE_SIDE, scanSide) : PAGE_SIDE;
      const viewport = page.getViewport({ scale: side / Math.max(size.width, size.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d')!;
      // прозрачный фон PDF — белым, иначе в JPEG он станет чёрным
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
      page.cleanup();
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error(`не удалось отрисовать страницу ${n}`);
      pages.push(new File([blob], doc.numPages > 1 ? `${base} — стр. ${n}.jpg` : `${base}.jpg`, { type: 'image/jpeg' }));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
