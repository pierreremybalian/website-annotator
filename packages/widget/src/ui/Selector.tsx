import { useEffect, useRef, useState } from 'preact/hooks';
import type { Rect } from '@annotate/shared';

const MIN_SIZE = 8;

interface Props {
  /** Called with the selection in viewport coordinates. */
  onSelect(rect: Rect): void;
  onCancel(): void;
}

interface Drag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function toRect(d: Drag): Rect {
  const clampX = (v: number) => Math.max(0, Math.min(v, window.innerWidth));
  const clampY = (v: number) => Math.max(0, Math.min(v, window.innerHeight));
  const x0 = clampX(d.x0);
  const x1 = clampX(d.x1);
  const y0 = clampY(d.y0);
  const y1 = clampY(d.y1);
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

/** Full-viewport crosshair overlay. Drag a rectangle; Esc or the Cancel pill cancels. */
export function Selector({ onSelect, onCancel }: Props) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const update = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    update({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    update({ ...d, x1: e.clientX, y1: e.clientY });
  };

  const onPointerUp = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const rect = toRect({ ...d, x1: e.clientX, y1: e.clientY });
    update(null);
    // A click or a tiny box selects nothing; the overlay stays up for another try.
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return;
    onSelect(rect);
  };

  const r = drag ? toRect(drag) : null;
  let label: { left: number; top: number } | null = null;
  if (r) {
    const below = r.y + r.height + 6;
    label = {
      left: Math.max(4, Math.min(r.x, window.innerWidth - 90)),
      top: below + 22 > window.innerHeight ? Math.max(4, r.y - 26) : below,
    };
  }

  return (
    <div
      class={`an-selector${r ? '' : ' an-empty'}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => update(null)}
      data-annotate="selector"
    >
      {r && (
        <div class="an-box" style={{ left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` }} />
      )}
      {r && label && (
        <div class="an-size" style={{ left: `${label.left}px`, top: `${label.top}px` }}>
          {Math.round(r.width)} × {Math.round(r.height)}
        </div>
      )}
      {!r && (
        <div class="an-hint">
          <span>Drag to select the area with the issue</span>
          <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={onCancel}>
            Cancel · Esc
          </button>
        </div>
      )}
    </div>
  );
}
