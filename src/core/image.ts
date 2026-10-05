/**
 * Предобработка фото накладной перед OCR. Чистый TypeScript без DOM,
 * поэтому одинаково работает в браузере (через canvas.getImageData) и в Node (тесты).
 *
 * Шаги:
 *  1. Серое изображение из max(R,G,B) — синие/красные чернила (печати, подписи,
 *     галочки ручкой) становятся светлыми, чёрный печатный текст остаётся тёмным.
 *  2. Локальный порог Sauvola — убирает тени и неравномерное освещение.
 *  3. Оценка высоты символа -> масштаб, чтобы текст был ~32 px (оптимум для Tesseract).
 *  4. Оценка перекоса по горизонтальным полосам -> переменный сдвиг (частично
 *     компенсирует перспективу, когда фото снято не строго сверху).
 *  5. Удаление длинных линий таблицы.
 */

export interface Gray {
  w: number;
  h: number;
  /** 0 = чёрный, 255 = белый */
  d: Uint8ClampedArray;
}

export interface PreprocessOptions {
  /** Желаемая высота строчных букв в пикселях после масштабирования */
  targetCharHeight?: number;
  /** Удалять ли линии таблицы */
  removeLines?: boolean;
  /** Подавлять цветные чернила (печати, подписи) */
  suppressColor?: boolean;
  /** Выравнивать перекос */
  deskew?: boolean;
}

export interface PreprocessResult {
  image: Gray;
  scale: number;
  charHeight: number;
  /** Углы перекоса по полосам (градусы), для отладки */
  skew: { y: number; angle: number; weight: number }[];
  lines?: LineInfo;
  /** Координаты найденных линий таблицы (горизонтальных по y и вертикальных по x) */
  rules: { h: number[]; v: number[] };
}

/**
 * Положения линий таблицы. Для каждой строки y считаем, какую часть ширины
 * покрывают пиксели линий в окне ±win строк (линии чуть наклонены и размазаны).
 * Настоящая линия таблицы тянется через всю таблицу; хвост рукописной галочки
 * или подчёркивание — лишь через небольшую её часть, их отбрасываем.
 */
export function findRules(mask: Uint8Array, len: number, buckets: number, minCoverage: number, charH: number): number[] {
  const win = Math.max(2, Math.round(charH / 3));
  const cnt = new Int32Array(buckets);
  let covered = 0;
  const cov = new Int32Array(len);
  const add = (row: number, delta: number) => {
    if (row < 0 || row >= len) return;
    const base = row * buckets;
    for (let b = 0; b < buckets; b++) {
      if (!mask[base + b]) continue;
      const before = cnt[b];
      cnt[b] += delta;
      if (before === 0 && cnt[b] > 0) covered++;
      else if (before > 0 && cnt[b] === 0) covered--;
    }
  };
  for (let r = -win; r < win; r++) add(r, 1);
  for (let i = 0; i < len; i++) {
    add(i + win, 1);
    cov[i] = covered;
    add(i - win, -1);
  }
  // Сплошные участки выше порога -> одна линия в точке максимума покрытия
  const res: number[] = [];
  const minGap = Math.max(4, Math.round(charH * 0.8));
  let i = 0;
  while (i < len) {
    if (cov[i] < minCoverage) { i++; continue; }
    let best = i;
    let j = i;
    while (j < len && cov[j] >= minCoverage) {
      if (cov[j] > cov[best]) best = j;
      j++;
    }
    // центр плато максимума
    let k = best;
    while (k + 1 < j && cov[k + 1] === cov[best]) k++;
    const y = Math.round((best + k) / 2);
    if (res.length && y - res[res.length - 1] < minGap) {
      if (cov[y] > cov[res[res.length - 1]]) res[res.length - 1] = y;
    } else res.push(y);
    i = j;
  }
  return res;
}

/** Средний цвет бумаги: светлые пиксели между 70 и 95 перцентилем яркости */
function paperColor(rgba: ArrayLike<number>, n: number): [number, number, number] {
  const hist = new Uint32Array(256);
  const step = Math.max(1, Math.floor(n / 200000));
  let cnt = 0;
  for (let i = 0; i < n; i += step) {
    const p = i * 4;
    hist[Math.round(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2])]++;
    cnt++;
  }
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc < cnt * 0.7) lo = v + 1;
    if (acc < cnt * 0.95) hi = v + 1;
  }
  let r = 0, g = 0, b = 0, m = 0;
  for (let i = 0; i < n; i += step) {
    const p = i * 4;
    const l = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    if (l >= lo && l <= hi) { r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2]; m++; }
  }
  if (m === 0) return [255, 255, 255];
  return [r / m, g / m, b / m];
}

/**
 * RGBA -> оттенки серого. При suppressColor сначала выравниваем баланс белого
 * по цвету бумаги (жёлтое/синее освещение), затем всё, что заметно отклоняется
 * от серого (синие галочки, печати, подписи), высветляем до белого.
 * Замер на реальных фото: синяя ручка/печать дают отклонение 25–50,
 * чёрный печатный текст и бумага — до 8.
 */
export function toGray(rgba: ArrayLike<number>, w: number, h: number, suppressColor = true): Gray {
  const n = w * h;
  const d = new Uint8ClampedArray(n);
  const [pr, pg, pb] = paperColor(rgba, n);
  const pl = (pr + pg + pb) / 3;
  const kr = pl / Math.max(1, pr), kg = pl / Math.max(1, pg), kb = pl / Math.max(1, pb);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p] * kr, g = rgba[p + 1] * kg, b = rgba[p + 2] * kb;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (suppressColor) {
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      const t = Math.min(1, Math.max(0, (sat - 13) / 12));
      d[i] = lum + (255 - lum) * t;
    } else {
      d[i] = lum;
    }
  }
  return { w, h, d };
}

/**
 * Маска листа бумаги: блоки, средняя яркость которых сильно ниже бумаги,
 * считаем фоном (стол, коврик, рука). Оставляем крупнейшую связную область
 * и заполняем дыры в ней (тёмные печати/таблицы внутри листа).
 * Возвращает функцию inside(x, y).
 */
export function paperMask(g: Gray, block = 24, growth = { step: 0.92, floor: 0.5 }, keepBorder = false): (x: number, y: number) => boolean {
  const bw = Math.ceil(g.w / block), bh = Math.ceil(g.h / block);
  // Средняя яркость блока и яркость бумаги в нём (70-й перцентиль — не зависит от плотности текста)
  const mean = new Float32Array(bw * bh);
  const paperOf = new Float32Array(bw * bh);
  const hist = new Uint16Array(256);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      let s = 0, c = 0;
      for (let y = by * block; y < Math.min(g.h, (by + 1) * block); y += 2) {
        for (let x = bx * block; x < Math.min(g.w, (bx + 1) * block); x += 2) { const v = g.d[y * g.w + x]; hist[v]++; s += v; c++; }
      }
      let acc = 0, v = 0;
      for (; v < 255; v++) { acc += hist[v]; if (acc >= c * 0.7) break; }
      mean[by * bw + bx] = s / c;
      paperOf[by * bw + bx] = v;
    }
  }
  const pct85 = (a: Float32Array) => Array.from(a).sort((x, y) => x - y)[Math.floor(a.length * 0.85)];
  const paper = pct85(mean), paperP = pct85(paperOf);
  const bright = new Uint8Array(bw * bh);
  for (let i = 0; i < bright.length; i++) bright[i] = mean[i] > paper * 0.72 ? 1 : 0;
  // Тень на листе темнеет плавно, а край листа (стол, коврик) — скачком: доращиваем лист в соседние
  // блоки, бумага в которых не более чем на 8% темнее уже найденной (плотный столбец сумм в тени
  // по средней яркости темнее порога и иначе отрезался бы как фон)
  const base = bright.slice();
  const grow: number[] = [];
  for (let i = 0; i < bright.length; i++) if (bright[i]) grow.push(i);
  while (grow.length) {
    const p = grow.pop()!;
    const x = p % bw, y = (p - x) / bw;
    for (const q of [x > 0 ? p - 1 : -1, x < bw - 1 ? p + 1 : -1, y > 0 ? p - bw : -1, y < bh - 1 ? p + bw : -1]) {
      if (q < 0 || bright[q] || paperOf[q] < paperOf[p] * growth.step || paperOf[q] < paperP * growth.floor) continue;
      bright[q] = 1;
      grow.push(q);
    }
  }
  // Доращённое мелкими кусками — не тень на листе, а соседний лист или узор коврика по краям:
  // такие куски (меньше 2,5% кадра) убираем, чтобы не добавлять OCR мусора
  const seen = new Uint8Array(bw * bh);
  for (let i = 0; i < bright.length; i++) {
    if (!bright[i] || base[i] || seen[i]) continue;
    const comp = [i];
    seen[i] = 1;
    for (let k = 0; k < comp.length; k++) {
      const p = comp[k], x = p % bw, y = (p - x) / bw;
      for (const q of [x > 0 ? p - 1 : -1, x < bw - 1 ? p + 1 : -1, y > 0 ? p - bw : -1, y < bh - 1 ? p + bw : -1]) {
        if (q >= 0 && bright[q] && !base[q] && !seen[q]) { seen[q] = 1; comp.push(q); }
      }
    }
    // Полоса у самого края кадра — это сам лист, уходящий за кадр (к краю фото темнее из-за виньетирования):
    // на ней часто стоит столбец «Сумма», стирать её нельзя
    const atBorder = keepBorder && comp.some((p) => { const x = p % bw, y = (p - x) / bw; return x === 0 || y === 0 || x === bw - 1 || y === bh - 1; });
    if (comp.length < bright.length * 0.025 && !atBorder) for (const p of comp) bright[p] = 0;
  }
  // крупнейшая связная область светлых блоков
  const label = new Int32Array(bw * bh).fill(-1);
  let bestLabel = -1, bestSize = 0, cur = 0;
  for (let i = 0; i < bright.length; i++) {
    if (!bright[i] || label[i] >= 0) continue;
    const st = [i];
    label[i] = cur;
    let size = 0;
    while (st.length) {
      const p = st.pop()!;
      size++;
      const x = p % bw, y = (p - x) / bw;
      const nb = [x > 0 ? p - 1 : -1, x < bw - 1 ? p + 1 : -1, y > 0 ? p - bw : -1, y < bh - 1 ? p + bw : -1];
      for (const q of nb) if (q >= 0 && bright[q] && label[q] < 0) { label[q] = cur; st.push(q); }
    }
    if (size > bestSize) { bestSize = size; bestLabel = cur; }
    cur++;
  }
  // заливка снаружи: всё, что не достижимо с краёв через «не-лист», — внутри листа
  const inside = new Uint8Array(bw * bh);
  const outside = new Uint8Array(bw * bh);
  const st: number[] = [];
  for (let x = 0; x < bw; x++) { st.push(x, (bh - 1) * bw + x); }
  for (let y = 0; y < bh; y++) { st.push(y * bw, y * bw + bw - 1); }
  while (st.length) {
    const p = st.pop()!;
    if (outside[p] || label[p] === bestLabel) continue;
    outside[p] = 1;
    const x = p % bw, y = (p - x) / bw;
    if (x > 0) st.push(p - 1);
    if (x < bw - 1) st.push(p + 1);
    if (y > 0) st.push(p - bw);
    if (y < bh - 1) st.push(p + bw);
  }
  for (let i = 0; i < inside.length; i++) inside[i] = outside[i] ? 0 : 1;
  // если «лист» подозрительно мал — маску не применяем
  let total = 0;
  for (let i = 0; i < inside.length; i++) total += inside[i];
  if (total < inside.length * 0.25) return () => true;
  return (x, y) => {
    const bx = Math.min(bw - 1, Math.max(0, Math.floor(x / block)));
    const by = Math.min(bh - 1, Math.max(0, Math.floor(y / block)));
    return inside[by * bw + bx] === 1;
  };
}

/** Уменьшение усреднением по площади (для больших фото) */
export function downscale(g: Gray, s: number): Gray {
  if (s >= 1) return g;
  const w = Math.max(1, Math.round(g.w * s));
  const h = Math.max(1, Math.round(g.h * s));
  const d = new Uint8ClampedArray(w * h);
  const fx = g.w / w, fy = g.h / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.min(g.h, Math.floor((y + 1) * fy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.min(g.w, Math.floor((x + 1) * fx));
      let sum = 0, n = 0;
      for (let yy = y0; yy < Math.max(y1, y0 + 1); yy++) {
        const row = yy * g.w;
        for (let xx = x0; xx < Math.max(x1, x0 + 1); xx++) {
          sum += g.d[row + xx];
          n++;
        }
      }
      d[y * w + x] = sum / n;
    }
  }
  return { w, h, d };
}

/** Порог Sauvola через интегральные изображения. Возвращает карту порогов. */
export function sauvolaThreshold(g: Gray, win: number, k = 0.25, R = 128): Float32Array {
  const { w, h, d } = g;
  const W1 = w + 1;
  const S = new Float64Array(W1 * (h + 1));
  const S2 = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rs2 = 0;
    for (let x = 0; x < w; x++) {
      const v = d[y * w + x];
      rs += v;
      rs2 += v * v;
      S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + rs;
      S2[(y + 1) * W1 + x + 1] = S2[y * W1 + x + 1] + rs2;
    }
  }
  const r = win >> 1;
  const T = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const n = (y1 - y0) * (x1 - x0);
      const a = y1 * W1 + x1, b = y0 * W1 + x1, c = y1 * W1 + x0, e = y0 * W1 + x0;
      const sum = S[a] - S[b] - S[c] + S[e];
      const sum2 = S2[a] - S2[b] - S2[c] + S2[e];
      const m = sum / n;
      const sd = Math.sqrt(Math.max(0, sum2 / n - m * m));
      T[y * w + x] = m * (1 + k * (sd / R - 1));
    }
  }
  return T;
}

export function binarize(g: Gray, T: Float32Array): Gray {
  const d = new Uint8ClampedArray(g.w * g.h);
  for (let i = 0; i < d.length; i++) d[i] = g.d[i] < T[i] ? 0 : 255;
  return { w: g.w, h: g.h, d };
}

/**
 * Медианная высота символов по связным компонентам.
 * Отбрасываем шум, линии таблицы и слипшиеся блоки.
 */
export function estimateCharHeight(bin: Gray): number {
  const { w, h, d } = bin;
  const seen = new Uint8Array(w * h);
  const heights: number[] = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (d[start] !== 0 || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let minX = w, maxX = 0, minY = h, maxY = 0, count = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w, y = (p - x) / w;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && d[p - 1] === 0 && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && d[p + 1] === 0 && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && d[p - w] === 0 && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && d[p + w] === 0 && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    const cw = maxX - minX + 1, ch = maxY - minY + 1;
    if (ch < 5 || ch > 120 || cw > ch * 2.5 || cw < 2 || count < 8) continue;
    const fill = count / (cw * ch);
    if (fill > 0.85 || fill < 0.08) continue;
    heights.push(ch);
  }
  if (heights.length < 20) return 20;
  heights.sort((a, b) => a - b);
  // Берём 60-й перцентиль: заглавные и цифры чуть выше строчных
  return heights[Math.floor(heights.length * 0.6)];
}

/**
 * Оценка угла перекоса в горизонтальных полосах изображения методом
 * проекционного профиля: при правильном угле строки текста дают острые пики.
 */
export function estimateSkewBands(bin: Gray, bands = 6, maxAngle = 5): { y: number; angle: number; weight: number }[] {
  // Работаем на уменьшенной копии для скорости
  const s = Math.min(1, 1200 / bin.w);
  const small = s < 1 ? downscale(bin, s) : bin;
  const { w, h, d } = small;
  const cx = w / 2;
  const res: { y: number; angle: number; weight: number }[] = [];
  const bandH = h / bands;
  for (let b = 0; b < bands; b++) {
    const y0 = Math.floor(b * bandH), y1 = Math.floor((b + 1) * bandH);
    const xs: number[] = [], ys: number[] = [];
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        if (d[y * w + x] < 128) { xs.push(x); ys.push(y); }
      }
    }
    if (xs.length < 200) continue;
    const score = (angDeg: number) => {
      const t = Math.tan((angDeg * Math.PI) / 180);
      const off = Math.ceil(Math.abs(t) * w) + 2;
      const hist = new Float64Array(y1 - y0 + 2 * off + 2);
      for (let i = 0; i < xs.length; i++) {
        const yy = ys[i] - y0 + off - t * (xs[i] - cx);
        hist[Math.round(yy)] += 1;
      }
      let sc = 0;
      for (let i = 1; i < hist.length; i++) {
        const dd = hist[i] - hist[i - 1];
        sc += dd * dd;
      }
      return sc;
    };
    let best = 0, bestSc = -1;
    for (let a = -maxAngle; a <= maxAngle + 1e-9; a += 0.25) {
      const sc = score(a);
      if (sc > bestSc) { bestSc = sc; best = a; }
    }
    for (let a = best - 0.25; a <= best + 0.25 + 1e-9; a += 0.05) {
      const sc = score(a);
      if (sc > bestSc) { bestSc = sc; best = a; }
    }
    const base = score(best + 2.5) + score(best - 2.5);
    const weight = base > 0 ? bestSc / (base / 2) : 1;
    res.push({ y: ((y0 + y1) / 2) / s, angle: best, weight: xs.length * Math.max(0, weight - 1) });
  }
  return res;
}

/** Линейная аппроксимация угла от y (взвешенный МНК) с защитой от выбросов */
function fitAngle(bands: { y: number; angle: number; weight: number }[]): (y: number) => number {
  const good = bands.filter((b) => b.weight > 0);
  if (good.length === 0) return () => 0;
  const median = [...good].sort((a, b) => a.angle - b.angle)[Math.floor(good.length / 2)].angle;
  const pts = good.filter((b) => Math.abs(b.angle - median) <= 1.5);
  if (pts.length < 2) return () => median;
  let sw = 0, sy = 0, sa = 0;
  for (const p of pts) { sw += p.weight; sy += p.weight * p.y; sa += p.weight * p.angle; }
  const my = sy / sw, ma = sa / sw;
  let num = 0, den = 0;
  for (const p of pts) { num += p.weight * (p.y - my) * (p.angle - ma); den += p.weight * (p.y - my) ** 2; }
  const slope = den > 0 ? num / den : 0;
  return (y: number) => ma + slope * (y - my);
}

/** Где найдены пиксели линий: по строкам y — какие 8-пиксельные корзины по x заняты (и наоборот) */
export interface LineInfo {
  /** h * hBuckets: для каждой строки y отмечены корзины x (x >> 3) с горизонтальной линией */
  hMask: Uint8Array;
  hBuckets: number;
  /** w * vBuckets: для каждого столбца x отмечены корзины y (y >> 3) с вертикальной линией */
  vMask: Uint8Array;
  vBuckets: number;
}

/**
 * Удаляем длинные горизонтальные и вертикальные линии (сетка таблицы).
 * Линии на фото не идеально прямые, поэтому ищем прогоны в полосе ±tol пикселей,
 * а стираем только тонкие участки — буквы, пересекающие линию, остаются.
 */
export function removeLongLines(bin: Gray, minLenH: number, minLenV: number, maxThick: number): { image: Gray; lines: LineInfo } {
  const { w, h } = bin;
  const src = bin.d;
  const cand = new Uint8Array(w * h);
  const isBlack = (x: number, y: number) => src[y * w + x] === 0;

  // Горизонтальные: полоса ±1 px, разрывы до 3 px
  for (let y = 0; y < h; y++) {
    let start = -1, gap = 0;
    for (let x = 0; x <= w; x++) {
      const on = x < w && (isBlack(x, y) || (y > 0 && isBlack(x, y - 1)) || (y < h - 1 && isBlack(x, y + 1)));
      if (on) { if (start < 0) start = x; gap = 0; continue; }
      if (start < 0) continue;
      gap++;
      if (gap > 3 || x === w) {
        const end = x - gap;
        if (end - start + 1 >= minLenH) for (let xx = start; xx <= end; xx++) if (isBlack(xx, y)) cand[y * w + xx] |= 1;
        start = -1; gap = 0;
      }
    }
  }
  // Вертикальные: полоса ±2 px (перспектива сильнее наклоняет вертикали)
  for (let x = 0; x < w; x++) {
    let start = -1, gap = 0;
    for (let y = 0; y <= h; y++) {
      let on = false;
      if (y < h) for (let dx = -2; dx <= 2 && !on; dx++) { const xx = x + dx; if (xx >= 0 && xx < w && isBlack(xx, y)) on = true; }
      if (on) { if (start < 0) start = y; gap = 0; continue; }
      if (start < 0) continue;
      gap++;
      if (gap > 3 || y === h) {
        const end = y - gap;
        if (end - start + 1 >= minLenV) for (let yy = start; yy <= end; yy++) if (isBlack(x, yy)) cand[yy * w + x] |= 2;
        start = -1; gap = 0;
      }
    }
  }

  const d = new Uint8ClampedArray(src);
  const hBuckets = (w >> 3) + 1, vBuckets = (h >> 3) + 1;
  const hMask = new Uint8Array(h * hBuckets);
  const vMask = new Uint8Array(w * vBuckets);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = cand[y * w + x];
      if (!c) continue;
      if (c & 1) {
        // толщина по вертикали
        let a = y, b = y;
        while (a > 0 && isBlack(x, a - 1)) a--;
        while (b < h - 1 && isBlack(x, b + 1)) b++;
        if (b - a + 1 <= maxThick) {
          for (let yy = a; yy <= b; yy++) d[yy * w + x] = 255;
          hMask[y * hBuckets + (x >> 3)] = 1;
        }
      }
      if (c & 2) {
        let a = x, b = x;
        while (a > 0 && isBlack(a - 1, y)) a--;
        while (b < w - 1 && isBlack(b + 1, y)) b++;
        if (b - a + 1 <= maxThick) {
          for (let xx = a; xx <= b; xx++) d[y * w + xx] = 255;
          vMask[x * vBuckets + (y >> 3)] = 1;
        }
      }
    }
  }
  return { image: { w, h, d }, lines: { hMask, hBuckets, vMask, vBuckets } };
}

/**
 * Пунктирные линии таблицы (узкие накладные с матричных и чековых принтеров). Сплошные линии убирает
 * removeLongLines, а пунктир остаётся, и Tesseract принимает таблицу за картинку — строки пропадают целиком.
 * Пунктир — длинная цепочка коротких чёрных отрезков с короткими промежутками; у текста такая цепочка
 * рвётся на пробелах между словами и на широких штрихах букв.
 */
export function removeDottedLines(bin: Gray, charH: number, maxThick: number): Gray {
  const { w, h } = bin;
  const src = bin.d;
  const d = new Uint8ClampedArray(src);
  // штрих пунктира на фото — 5–8 px при высоте символа 24, промежуток — 4–9 px
  const maxRun = Math.max(4, Math.round(charH * 0.4));
  const maxGap = Math.max(5, Math.round(charH * 0.45));
  // на таком расстоянии по обе стороны от линии пусто: линия стоит между строками текста,
  // а цепочка коротких штрихов внутри строки текста окружена телами букв
  const off = maxThick + 2;
  const isBlack = (x: number, y: number) => src[y * w + x] === 0;
  // along: длина строки/столбца, across: число строк/столбцов; at(i, j) — пиксель j-й линии в позиции i
  const scan = (along: number, across: number, at: (i: number, j: number) => boolean, minLen: number, erase: (i: number, j: number) => void) => {
    for (let j = 0; j < across; j++) {
      // (без «полосы» ±1 px: соседние ряды точек, сложенные вместе, дают отрезки длиннее точки)
      const on = (i: number) => at(i, j);
      let start = -1, runs = 0, lastEnd = -1, i = 0;
      const flush = (end: number) => {
        let near = 0, n = 0;
        if (start >= 0 && end - start >= minLen) {
          for (let k = start; k < end; k += 2) {
            n++;
            if ((j - off >= 0 && at(k, j - off)) || (j + off < across && at(k, j + off))) near++;
          }
        }
        if (start >= 0 && end - start >= minLen && runs >= (end - start) / (maxRun + maxGap + 2) && near <= n * 0.12) {
          for (let k = start; k < end; k++) for (let dj = -1; dj <= 1; dj++) if (j + dj >= 0 && j + dj < across && at(k, j + dj)) erase(k, j + dj);
        }
        start = -1; runs = 0;
      };
      while (i < along) {
        if (!on(i)) { i++; continue; }
        let e = i;
        while (e < along && on(e)) e++;
        const len = e - i;
        if (len > maxRun) { flush(lastEnd); }
        else if (start >= 0 && i - lastEnd <= maxGap) { runs++; }
        else { flush(lastEnd); start = i; runs = 1; }
        lastEnd = len > maxRun ? -1 : e;
        i = e;
      }
      flush(lastEnd);
    }
  };
  // стираем только тонкое: буква, которую пересекает линия, остаётся
  const thinV = (x: number, y: number) => { let a = y, b = y; while (a > 0 && isBlack(x, a - 1)) a--; while (b < h - 1 && isBlack(x, b + 1)) b++; return b - a + 1 <= maxThick; };
  const thinH = (x: number, y: number) => { let a = x, b = x; while (a > 0 && isBlack(a - 1, y)) a--; while (b < w - 1 && isBlack(b + 1, y)) b++; return b - a + 1 <= maxThick; };
  scan(w, h, (x, y) => isBlack(x, y), Math.round(charH * 12), (x, y) => { if (thinV(x, y)) d[y * w + x] = 255; });
  scan(h, w, (y, x) => isBlack(x, y), Math.round(charH * 5), (y, x) => { if (thinH(x, y)) d[y * w + x] = 255; });
  return { w, h, d };
}

/** Удаляем мелкий шум (связные компоненты из нескольких пикселей) */
export function despeckle(bin: Gray, maxArea: number): Gray {
  const { w, h } = bin;
  const d = new Uint8ClampedArray(bin.d);
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const comp: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (d[start] !== 0 || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    comp.length = 0;
    while (sp > 0) {
      const p = stack[--sp];
      comp.push(p);
      const x = p % w;
      if (x > 0 && d[p - 1] === 0 && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && d[p + 1] === 0 && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (p >= w && d[p - w] === 0 && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (p < w * (h - 1) && d[p + w] === 0 && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    if (comp.length <= maxArea) for (const p of comp) d[p] = 255;
  }
  return { w, h, d };
}

/**
 * Насколько текст похож на повёрнутый на 90°: отношение «изрезанности» профиля чёрных пикселей по столбцам
 * к профилю по строкам. У обычного текста профиль по строкам — гребёнка (строка, пробел, строка), а по столбцам
 * буквы разных строк усредняются; у лежащего на боку — наоборот. Больше 1 — похоже на повёрнутый.
 */
export function sidewaysScore(bin: Gray): number {
  const rows = new Float64Array(bin.h), cols = new Float64Array(bin.w);
  for (let y = 0; y < bin.h; y++) {
    for (let x = 0; x < bin.w; x++) if (bin.d[y * bin.w + x] === 0) { rows[y]++; cols[x]++; }
  }
  const rough = (p: Float64Array) => {
    let d = 0, s = 0;
    for (let i = 1; i < p.length; i++) { d += Math.abs(p[i] - p[i - 1]); s += p[i]; }
    return s ? d / s : 0;
  };
  const r = rough(rows);
  return r ? rough(cols) / r : 0;
}

/** Поворот RGBA на 90° по часовой стрелке (cw) или против */
export function rotate90(rgba: ArrayLike<number>, w: number, h: number, cw: boolean): { data: Uint8ClampedArray; width: number; height: number } {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = cw ? h - 1 - y : y, ny = cw ? x : w - 1 - x;
      const s = (y * w + x) * 4, d = (ny * h + nx) * 4;
      out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3];
    }
  }
  return { data: out, width: h, height: w };
}

/**
 * Полный конвейер: цветное RGBA -> чистое чёрно-белое изображение для OCR.
 */
export function preprocess(rgba: ArrayLike<number>, w: number, h: number, opts: PreprocessOptions = {}): PreprocessResult {
  const target = opts.targetCharHeight ?? 24;
  let g = toGray(rgba, w, h, opts.suppressColor ?? true);

  // Слишком большие фото сначала уменьшаем до разумного размера анализа
  const maxDim = Math.max(g.w, g.h);
  if (maxDim > 3200) g = downscale(g, 3200 / maxDim);

  const inPaper = paperMask(g, Math.max(16, Math.round(Math.max(g.w, g.h) / 80)));
  const win = Math.max(15, Math.round(Math.min(g.w, g.h) / 40)) | 1;
  const T = sauvolaThreshold(g, win);
  const bin0 = binarize(g, T);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (!inPaper(x, y)) bin0.d[y * g.w + x] = 255;

  const charHeight = estimateCharHeight(bin0);
  const scale = Math.min(4, Math.max(0.5, target / charHeight));

  const skew = opts.deskew === false ? [] : estimateSkewBands(bin0);
  const angleAt = fitAngle(skew);

  // Масштабирование + выравнивание + бинаризация за один проход (билинейная выборка)
  const W = Math.round(g.w * scale), H = Math.round(g.h * scale);
  const out = new Uint8ClampedArray(W * H);
  const cx = g.w / 2;
  const tanCache = new Float32Array(H);
  for (let y = 0; y < H; y++) tanCache[y] = Math.tan((angleAt(y / scale) * Math.PI) / 180);
  for (let y = 0; y < H; y++) {
    const ysBase = y / scale;
    const t = tanCache[y];
    for (let x = 0; x < W; x++) {
      const xs = x / scale;
      const ys = ysBase + t * (xs - cx);
      if (ys < 0 || ys > g.h - 1 || xs > g.w - 1 || !inPaper(xs, ys)) { out[y * W + x] = 255; continue; }
      const x0 = Math.floor(xs), y0 = Math.floor(ys);
      const fx = xs - x0, fy = ys - y0;
      const i00 = y0 * g.w + x0;
      const i01 = x0 + 1 < g.w ? i00 + 1 : i00;
      const i10 = y0 + 1 < g.h ? i00 + g.w : i00;
      const i11 = x0 + 1 < g.w ? i10 + 1 : i10;
      const gv = (g.d[i00] * (1 - fx) + g.d[i01] * fx) * (1 - fy) + (g.d[i10] * (1 - fx) + g.d[i11] * fx) * fy;
      const tv = (T[i00] * (1 - fx) + T[i01] * fx) * (1 - fy) + (T[i10] * (1 - fx) + T[i11] * fx) * fy;
      out[y * W + x] = gv < tv ? 0 : 255;
    }
  }
  let image: Gray = { w: W, h: H, d: out };
  const outChar = charHeight * scale;
  let lines: LineInfo | undefined;
  if (opts.removeLines !== false) {
    // Горизонтальная линия должна быть длиннее любого слова/числа (штрихкод ≈ 10 высот символа),
    // иначе плотные ряды цифр принимаются за линии
    const r = removeLongLines(image, Math.round(outChar * 12), Math.round(outChar * 5), Math.max(3, Math.round(outChar * 0.28)));
    image = removeDottedLines(r.image, outChar, Math.max(3, Math.round(outChar * 0.28)));
    lines = r.lines;
  }
  image = despeckle(image, Math.max(3, Math.round(outChar * outChar * 0.015)));
  const rules = lines
    ? {
      h: findRules(lines.hMask, H, lines.hBuckets, (W * 0.3) / 8, outChar),
      v: findRules(lines.vMask, W, lines.vBuckets, (H * 0.1) / 8, outChar),
    }
    : { h: [], v: [] };
  return { image, scale, charHeight, skew, lines, rules };
}

/** Gray -> RGBA (для canvas / PNG) */
export function grayToRGBA(g: Gray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(g.w * g.h * 4);
  for (let i = 0, p = 0; i < g.d.length; i++, p += 4) {
    out[p] = out[p + 1] = out[p + 2] = g.d[i];
    out[p + 3] = 255;
  }
  return out;
}
