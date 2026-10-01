import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconX } from './Icons';

/**
 * Просмотр фото накладной: перетаскивание мышью или пальцем, масштаб колесом с Ctrl (в полноэкранном
 * режиме — просто колесом) и щипком, двойной щелчок — приблизить к точке / вписать, поворот на 90°.
 * Изображение рисуется трансформацией, а не прокруткой: так масштаб идёт к курсору и пальцам.
 */
interface View { s: number; r: number; cx: number; cy: number }
type Fit = 'width' | 'page';

const MIN = 0.05, MAX = 8;
const clampS = (s: number) => Math.min(MAX, Math.max(MIN, s));

interface Props {
  src: string;
  alt: string;
  /** Полноэкранный режим: колесо масштабирует, клавиши, кнопка «Закрыть» */
  full?: boolean;
  onClose?: () => void;
  /** Начальный поворот (из панели в полноэкранный режим) */
  rotation?: number;
  onRotation?: (r: number) => void;
}

export function PhotoViewer({ src, alt, full, onClose, rotation = 0, onRotation }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number }>();
  const [view, setView] = useState<View>({ s: 1, r: rotation, cx: 0, cy: 0 });
  const [isFull, setFull] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; s: number; mid: { x: number; y: number }; c: { x: number; y: number } }>();
  const lastTap = useRef(0);

  const size = () => {
    const el = box.current;
    return el ? { w: el.clientWidth, h: el.clientHeight } : { w: 1, h: 1 };
  };
  /** Размер повёрнутого изображения при масштабе 1 */
  const rotated = (r: number) => (nat ? (r % 180 ? { w: nat.h, h: nat.w } : nat) : { w: 1, h: 1 });

  /** Не даём изображению уехать: меньше окна — по центру, больше — края не отходят от краёв окна */
  const clamp = useCallback((v: View): View => {
    const { w, h } = size();
    const rb = rotated(v.r);
    const ew = rb.w * v.s, eh = rb.h * v.s;
    const cx = ew <= w ? w / 2 : Math.min(ew / 2, Math.max(w - ew / 2, v.cx));
    const cy = eh <= h ? h / 2 : Math.min(eh / 2, Math.max(h - eh / 2, v.cy));
    return { ...v, cx, cy };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nat]);

  const fit = useCallback((mode: Fit, r = view.r) => {
    const { w, h } = size();
    const rb = rotated(r);
    const s = clampS(mode === 'width' ? w / rb.w : Math.min(w / rb.w, h / rb.h));
    // по ширине — с начала листа (шапка накладной), целиком — по центру
    setView(clamp({ s, r, cx: w / 2, cy: mode === 'width' ? (rb.h * s) / 2 : h / 2 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nat, view.r, clamp]);

  // Новое фото — вписываем: в панели по ширине, в полноэкранном режиме целиком
  useLayoutEffect(() => { if (nat) fit(full ? 'page' : 'width', rotation); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [nat]);
  useEffect(() => { setNat(undefined); }, [src]);
  // Окно поменяло размер (свернули фото, повернули телефон) — держим изображение в границах
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setView((v) => clamp(v)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [clamp]);

  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    setView((v) => {
      const { w, h } = size();
      const x = px ?? w / 2, y = py ?? h / 2;
      const s = clampS(v.s * factor);
      const k = s / v.s;
      return clamp({ ...v, s, cx: x + (v.cx - x) * k, cy: y + (v.cy - y) * k });
    });
  }, [clamp]);

  const rotate = () => {
    const r = (view.r + 90) % 360;
    onRotation?.(r);
    fit(full ? 'page' : 'width', r);
  };

  // Колесо: в панели — прокрутка (Ctrl / щипок тачпада — масштаб), в полноэкранном режиме — масштаб.
  // Обработчик не пассивный, иначе нельзя отменить прокрутку страницы.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      if (full || e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // колесо мыши — шаг ×1,25 за щелчок; щипок тачпада (мелкие deltaY) — плавно
        const f = Math.abs(e.deltaY) >= 40 ? (e.deltaY < 0 ? 1.25 : 0.8) : Math.exp(-e.deltaY * 0.01);
        zoomAt(f, e.clientX - rect.left, e.clientY - rect.top);
        return;
      }
      const dx = e.shiftKey ? e.deltaY : e.deltaX, dy = e.shiftKey ? 0 : e.deltaY;
      setView((v) => {
        const next = clamp({ ...v, cx: v.cx - dx, cy: v.cy - dy });
        // лист уже у края — отдаём прокрутку странице
        if (next.cx !== v.cx || next.cy !== v.cy) e.preventDefault();
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [full, zoomAt, clamp]);

  // Клавиши в полноэкранном режиме
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      const step = 80;
      if (e.key === 'Escape') onClose?.();
      else if (e.key === '+' || e.key === '=') zoomAt(1.25);
      else if (e.key === '-') zoomAt(0.8);
      else if (e.key === '0') fit('page');
      else if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') rotate();
      else if (e.key.startsWith('Arrow')) {
        const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key] ?? [0, 0];
        setView((v) => clamp({ ...v, cx: v.cx + d[0], cy: v.cy + d[1] }));
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const local = (e: React.PointerEvent) => {
    const rect = box.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    box.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), s: view.s, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, c: { x: view.cx, y: view.cy } };
    }
    // двойное касание пальцем (dblclick на телефоне ненадёжен)
    if (e.pointerType === 'touch' && pointers.current.size === 1) {
      const now = Date.now();
      if (now - lastTap.current < 300) toggleZoom(local(e));
      lastTap.current = now;
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size >= 2 && gesture.current) {
      // щипок: масштаб от расстояния между пальцами, сдвиг — за серединой
      const [a, b] = [...pointers.current.values()];
      const g = gesture.current;
      const s = clampS(g.s * Math.hypot(a.x - b.x, a.y - b.y) / g.dist);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const k = s / g.s;
      setView((v) => clamp({ ...v, s, cx: mid.x + (g.c.x - g.mid.x) * k, cy: mid.y + (g.c.y - g.mid.y) * k }));
      return;
    }
    setView((v) => clamp({ ...v, cx: v.cx + p.x - prev.x, cy: v.cy + p.y - prev.y }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = undefined;
  };

  /** Двойной щелчок: вписано — приблизить к точке в 2,5 раза; приближено — вписать */
  const toggleZoom = (p: { x: number; y: number }) => {
    const { w } = size();
    const fitS = w / rotated(view.r).w;
    if (view.s > fitS * 1.3) fit(full ? 'page' : 'width');
    else zoomAt((fitS * 2.5) / view.s, p.x, p.y);
  };

  const rb = rotated(view.r);
  const pct = Math.round(view.s * 100);

  return (
    <div className={`pv ${full ? 'pv--full' : ''}`}>
      <div
        ref={box}
        className="pv__stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button')) toggleZoom(local(e as unknown as React.PointerEvent)); }}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          style={{
            visibility: nat ? 'visible' : 'hidden',
            transform: `translate(${view.cx}px, ${view.cy}px) rotate(${view.r}deg) scale(${view.s}) translate(${-(nat?.w ?? 0) / 2}px, ${-(nat?.h ?? 0) / 2}px)`,
          }}
        />
        {!nat && <div className="pv__loading muted">Загрузка фото…</div>}
      </div>
      <div className="pv__tools" role="toolbar" aria-label="Просмотр фото">
        <button type="button" onClick={() => zoomAt(0.8)} aria-label="Уменьшить" title="Уменьшить (−)">−</button>
        <button type="button" className="pv__pct" onClick={() => fit('page')} title="Вписать целиком (0)">{pct}%</button>
        <button type="button" onClick={() => zoomAt(1.25)} aria-label="Увеличить" title="Увеличить (+)">+</button>
        <span className="pv__sep" />
        <button type="button" onClick={() => fit('width')} title="По ширине">↔</button>
        <button type="button" onClick={() => fit('page')} title="Целиком">⤢</button>
        <button type="button" onClick={rotate} aria-label="Повернуть" title="Повернуть на 90° (R)">⟳</button>
        {!full && <button type="button" onClick={() => setFull(true)} aria-label="Во весь экран" title="Во весь экран">⛶</button>}
        {full && <button type="button" onClick={onClose} aria-label="Закрыть" title="Закрыть (Esc)"><IconX /></button>}
      </div>
      {!full && rb.w > 1 && (
        <div className="pv__hint">Тащите мышью · Ctrl + колесо — масштаб · двойной щелчок — приблизить</div>
      )}
      {isFull && createPortal(
        <div className="pv-overlay" role="dialog" aria-modal="true" aria-label="Фото накладной">
          <PhotoViewer src={src} alt={alt} full rotation={view.r} onRotation={(r) => fit('width', r)} onClose={() => setFull(false)} />
        </div>,
        document.body,
      )}
    </div>
  );
}
