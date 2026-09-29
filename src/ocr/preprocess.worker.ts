/// <reference lib="webworker" />
// Предобработка в отдельном потоке, чтобы интерфейс не зависал на 2–3 секунды.
import { preprocess, grayToRGBA } from '../core/image';

export interface PreprocessRequest {
  id: number;
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface PreprocessResponse {
  id: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  rules: { h: number[]; v: number[] };
  charHeight: number;
  error?: string;
}

self.onmessage = (e: MessageEvent<PreprocessRequest>) => {
  const { id, data, width, height } = e.data;
  try {
    const res = preprocess(data, width, height);
    const rgba = grayToRGBA(res.image);
    const msg: PreprocessResponse = {
      id,
      width: res.image.w,
      height: res.image.h,
      rgba,
      rules: res.rules,
      charHeight: res.charHeight * res.scale,
    };
    (self as unknown as Worker).postMessage(msg, [rgba.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
