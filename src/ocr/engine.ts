/**
 * Распознавание фото накладной в браузере:
 * фото -> (воркер) предобработка -> Tesseract (rus+eng) в два прохода -> разбор формата.
 */
import { createWorker, type Worker as TessWorker, PSM } from 'tesseract.js';
import { toOcrPage, type OcrPage } from '../core/ocrTypes';
import { recognizePage, type Recognizer } from '../core/pipeline';
import { grayToRGBA, type Gray } from '../core/image';
import type { ParsedDoc } from '../core/types';
import type { PreprocessRequest, PreprocessResponse } from './preprocess.worker';

export interface RecognizeResult {
  page: OcrPage;
  doc: ParsedDoc;
  /** Обработанное изображение (то, что «видел» OCR) */
  processedUrl: string;
}

export type Progress = (stage: string, fraction: number) => void;

const BASE = import.meta.env.BASE_URL;
/** Максимальная сторона фото для анализа — больше не нужно и тяжело для памяти телефона */
const MAX_SIDE = 3200;

let tessPromise: Promise<TessWorker> | null = null;
let onTessProgress: ((p: number) => void) | null = null;

function getTesseract(): Promise<TessWorker> {
  if (!tessPromise) {
    const abs = (p: string) => new URL(BASE + p, location.href).toString();
    tessPromise = (async () => {
      const w = await createWorker(['rus', 'eng'], 1, {
        workerPath: abs('tesseract/worker.min.js'),
        corePath: abs('tesseract/core'),
        langPath: abs('tesseract/lang'),
        logger: (m: { status: string; progress: number }) => {
          if (m.status === 'recognizing text') onTessProgress?.(m.progress);
        },
      });
      await w.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      });
      return w;
    })();
    tessPromise.catch(() => { tessPromise = null; });
  }
  return tessPromise;
}

let ppWorker: Worker | null = null;
let ppSeq = 0;
function preprocessInWorker(img: ImageData): Promise<PreprocessResponse> {
  if (!ppWorker) ppWorker = new Worker(new URL('./preprocess.worker.ts', import.meta.url), { type: 'module' });
  const id = ++ppSeq;
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<PreprocessResponse>) => {
      if (e.data.id !== id) return;
      ppWorker!.removeEventListener('message', onMsg);
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data);
    };
    ppWorker!.addEventListener('message', onMsg);
    const req: PreprocessRequest = { id, data: img.data, width: img.width, height: img.height };
    ppWorker!.postMessage(req, [img.data.buffer]);
  });
}

/** Декодирует фото с учётом EXIF-поворота и уменьшает слишком большие */
export async function loadImageData(file: Blob): Promise<ImageData> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return ctx.getImageData(0, 0, w, h);
}

function grayToPng(g: Gray): Promise<Blob> {
  const canvas = new OffscreenCanvas(g.w, g.h);
  canvas.getContext('2d')!.putImageData(new ImageData(grayToRGBA(g) as Uint8ClampedArray<ArrayBuffer>, g.w, g.h), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Очередь: Tesseract-воркер один, поэтому распознаём строго по одному фото */
let chain: Promise<unknown> = Promise.resolve();

export function recognizeInvoice(file: Blob, onProgress: Progress): Promise<RecognizeResult> {
  const run = async (): Promise<RecognizeResult> => {
    try {
      onProgress('Подготовка изображения', 0.02);
      const tessReady = getTesseract();
      const img = await loadImageData(file);
      onProgress('Выравнивание и очистка фото', 0.05);
      const pre = await preprocessInWorker(img);
      const image: Gray = { w: pre.width, h: pre.height, d: new Uint8ClampedArray(pre.width * pre.height) };
      for (let i = 0; i < image.d.length; i++) image.d[i] = pre.rgba[i * 4];
      const processedPng = await grayToPng(image);
      onProgress('Загрузка OCR-движка', 0.15);
      const tess = await tessReady;

      // Первый проход (вся страница) — до 70% прогресса, второй (столбцы) — остальное
      let pass = 0;
      onTessProgress = (p) => onProgress(pass === 0 ? 'Распознавание текста' : 'Уточнение чисел по столбцам', pass === 0 ? 0.2 + p * 0.5 : 0.7);
      const recognize: Recognizer = async (g, opts) => {
        await tess.setParameters({ tessedit_char_whitelist: opts.whitelist ?? '' });
        const png = g === image ? processedPng : await grayToPng(g);
        const { data } = await tess.recognize(png, {}, { text: true, blocks: true });
        pass++;
        return toOcrPage(data, g.w, g.h).lines;
      };
      const { page, doc } = await recognizePage(image, { rules: pre.rules, charHeight: pre.charHeight }, recognize,
        (stage, f) => onProgress(stage, 0.7 + f * 0.28));
      if (import.meta.env.DEV) {
        const g = globalThis as Record<string, unknown>;
        g.__ocrPages = [...((g.__ocrPages as OcrPage[] | undefined) ?? []), page];
      }
      onProgress('Готово', 1);
      return { page, doc, processedUrl: URL.createObjectURL(processedPng) };
    } finally {
      onTessProgress = null;
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}
