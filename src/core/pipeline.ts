/**
 * Общий конвейер распознавания (браузер и Node отличаются только функцией OCR):
 *  1. OCR всей страницы -> определение формата и примерной структуры таблицы.
 *  2. Для таблиц: повторный OCR каждого столбца чисел узкой полосой с фильтром
 *     «только цифры». Так Tesseract не путает цифры с буквами и не смешивает
 *     соседние столбцы; прочтения обоих проходов голосуют при сверке строки.
 *  3. Разбор накладной.
 */
import type { Gray } from './image';
import type { OcrLine, OcrPage, OcrStrip } from './ocrTypes';
import { parseDocument, planStrips } from './parse';
import type { ParsedDoc } from './types';

export interface RecognizeOptions {
  /** tessedit_char_whitelist; пусто — без ограничений */
  whitelist?: string;
}

/** Распознаёт изображение и возвращает строки в координатах этого изображения */
export type Recognizer = (img: Gray, opts: RecognizeOptions) => Promise<OcrLine[]>;

export function cropGray(g: Gray, x0: number, y0: number, x1: number, y1: number, pad = 12): Gray {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(g.w, Math.ceil(x1)); y1 = Math.min(g.h, Math.ceil(y1));
  const w = Math.max(1, x1 - x0) + pad * 2, h = Math.max(1, y1 - y0) + pad * 2;
  const d = new Uint8ClampedArray(w * h).fill(255);
  for (let y = y0; y < y1; y++) {
    d.set(g.d.subarray(y * g.w + x0, y * g.w + x1), (y - y0 + pad) * w + pad);
  }
  return { w, h, d };
}

function shiftLines(lines: OcrLine[], dx: number, dy: number): OcrLine[] {
  return lines.map((l) => ({
    ...l,
    x0: l.x0 + dx, x1: l.x1 + dx, y0: l.y0 + dy, y1: l.y1 + dy,
    words: l.words.map((w) => ({ ...w, x0: w.x0 + dx, x1: w.x1 + dx, y0: w.y0 + dy, y1: w.y1 + dy })),
  }));
}

/** Сколько слов прочитано уверенно (кириллица от 4 букв): у фото, лежащего на боку, таких почти нет */
export function textQuality(lines: OcrLine[]): number {
  let n = 0;
  for (const l of lines) for (const w of l.words) if (w.conf >= 70 && /[А-Яа-яЁё]{4,}/.test(w.text)) n++;
  return n;
}

type PageExtra = Pick<OcrPage, 'rules' | 'charHeight'>;
/** Предобработанное фото, повёрнутое на 90° по часовой стрелке (cw) или против */
export type Rotated = (cw: boolean) => Promise<{ image: Gray; extra: PageExtra }>;

export async function recognizePage(
  image: Gray,
  extra: PageExtra,
  recognize: Recognizer,
  onStage?: (stage: string, fraction: number) => void,
  rotated?: Rotated,
): Promise<{ page: OcrPage; doc: ParsedDoc; image: Gray }> {
  let lines = await recognize(image, {});
  // Фото снято боком (EXIF об этом молчит): текста почти не найдено — пробуем оба поворота и берём лучший
  const q0 = textQuality(lines);
  if (rotated && q0 < 8) {
    for (const cw of [true, false]) {
      onStage?.('Фото повёрнуто — пробуем развернуть', 0);
      const cand = await rotated(cw);
      const l = await recognize(cand.image, {});
      if (textQuality(l) >= Math.max(10, q0 * 3, textQuality(lines) + 1)) { image = cand.image; extra = cand.extra; lines = l; }
    }
  }
  const page: OcrPage = { width: image.w, height: image.h, lines: [...lines].sort((a, b) => a.y0 - b.y0), ...extra };
  const plan = planStrips(page);
  if (plan.length) {
    const strips: OcrStrip[] = [];
    for (let i = 0; i < plan.length; i++) {
      const s = plan[i];
      onStage?.('Уточнение чисел по столбцам', i / plan.length);
      const pad = 12;
      const crop = cropGray(image, s.x0, s.y0, s.x1, s.y1, pad);
      const sl = await recognize(crop, { whitelist: s.whitelist });
      strips.push({ role: s.role, x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, lines: shiftLines(sl, Math.max(0, Math.floor(s.x0)) - pad, Math.max(0, Math.floor(s.y0)) - pad) });
    }
    page.strips = strips;
  }
  return { page, doc: parseDocument(page), image };
}
