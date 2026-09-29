/** Нормализованный результат OCR, не зависящий от версии tesseract.js */

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord extends BBox {
  text: string;
  conf: number;
}

export interface OcrLine extends BBox {
  text: string;
  conf: number;
  words: OcrWord[];
}

/** Результат повторного OCR узкой полосы (одного столбца таблицы) с фильтром «только цифры» */
export interface OcrStrip extends BBox {
  role: string;
  /** Строки в координатах всей страницы */
  lines: OcrLine[];
}

/** Что распознать вторым проходом */
export interface StripPlan extends BBox {
  role: string;
  whitelist: string;
}

export interface OcrPage {
  width: number;
  height: number;
  lines: OcrLine[];
  strips?: OcrStrip[];
  /** Линии таблицы, найденные при предобработке */
  rules?: { h: number[]; v: number[] };
  /** Примерная высота символа на обработанном изображении */
  charHeight?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function toOcrPage(
  data: any,
  width: number,
  height: number,
  extra: Pick<OcrPage, 'rules' | 'charHeight'> = {},
): OcrPage {
  const lines: OcrLine[] = [];
  const blocks: any[] = data.blocks ?? [];
  for (const b of blocks) {
    for (const p of b.paragraphs ?? []) {
      for (const l of p.lines ?? []) {
        const words: OcrWord[] = (l.words ?? []).map((w: any) => ({
          text: w.text,
          conf: Math.round(w.confidence),
          ...w.bbox,
        }));
        lines.push({ text: (l.text ?? '').replace(/\n$/, ''), conf: Math.round(l.confidence), ...l.bbox, words });
      }
    }
  }
  // Если блоков нет (другая версия API) — берём data.lines
  if (lines.length === 0 && Array.isArray(data.lines)) {
    for (const l of data.lines) {
      lines.push({
        text: (l.text ?? '').replace(/\n$/, ''),
        conf: Math.round(l.confidence),
        ...l.bbox,
        words: (l.words ?? []).map((w: any) => ({ text: w.text, conf: Math.round(w.confidence), ...w.bbox })),
      });
    }
  }
  lines.sort((a, b) => a.y0 - b.y0);
  return { width, height, lines, ...extra };
}
