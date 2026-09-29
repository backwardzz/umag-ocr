/** Геометрические помощники над словами OCR */
import type { OcrPage } from './ocrTypes';

export interface Word {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  cx: number;
  cy: number;
  conf: number;
  line: number;
}

export function flattenWords(page: OcrPage): Word[] {
  const out: Word[] = [];
  page.lines.forEach((l, li) => {
    for (const w of l.words) {
      const text = w.text.trim();
      if (!text) continue;
      out.push({ text, x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1, cx: (w.x0 + w.x1) / 2, cy: (w.y0 + w.y1) / 2, conf: w.conf, line: li });
    }
  });
  return out;
}

export function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** Типичная высота строки текста по словам из букв */
export function typicalLineHeight(words: Word[], page: OcrPage): number {
  const hs = words.filter((w) => /[A-Za-zА-Яа-яЁё]{3,}/.test(w.text)).map((w) => w.y1 - w.y0);
  const m = median(hs);
  if (m > 0) return m;
  return (page.charHeight ?? 24) * 1.4;
}

/** Одномерная кластеризация значений с допуском */
export function cluster1d(values: number[], tol: number): { center: number; count: number; members: number[] }[] {
  const s = [...values].sort((a, b) => a - b);
  const res: { center: number; count: number; members: number[] }[] = [];
  for (const v of s) {
    const last = res[res.length - 1];
    if (last && v - last.members[last.members.length - 1] <= tol) {
      last.members.push(v);
      last.count++;
      last.center = median(last.members);
    } else {
      res.push({ center: v, count: 1, members: [v] });
    }
  }
  return res;
}

/** Группирует слова в «ячейки» по горизонтальному зазору (слова одной ячейки идут вплотную) */
export function groupCells(words: Word[], maxGap: number): Word[][] {
  const s = [...words].sort((a, b) => a.x0 - b.x0);
  const cells: Word[][] = [];
  for (const w of s) {
    const last = cells[cells.length - 1];
    if (last) {
      const prev = last[last.length - 1];
      if (w.x0 - prev.x1 <= maxGap && Math.abs(w.cy - prev.cy) < (prev.y1 - prev.y0)) {
        last.push(w);
        continue;
      }
    }
    cells.push([w]);
  }
  return cells;
}

export const cellText = (cell: Word[]) => cell.map((w) => w.text).join(' ');
export const cellX1 = (cell: Word[]) => Math.max(...cell.map((w) => w.x1));
export const cellX0 = (cell: Word[]) => Math.min(...cell.map((w) => w.x0));
export const cellCy = (cell: Word[]) => median(cell.map((w) => w.cy));

/** Собирает слова в строки текста по y и склеивает */
export function wordsToText(words: Word[], lineH: number): string {
  const rows = cluster1d(words.map((w) => w.cy), lineH * 0.5);
  const parts: string[] = [];
  for (const r of rows) {
    const lo = r.members[0] - 0.01, hi = r.members[r.members.length - 1] + 0.01;
    const ws = words.filter((w) => w.cy >= lo && w.cy <= hi).sort((a, b) => a.x0 - b.x0);
    parts.push(ws.map((w) => w.text).join(' '));
  }
  return parts.join(' ');
}

/** Весь текст страницы одной строкой (для поиска ключевых слов) */
export function pageText(page: OcrPage): string {
  return page.lines.map((l) => l.text).join('\n');
}
