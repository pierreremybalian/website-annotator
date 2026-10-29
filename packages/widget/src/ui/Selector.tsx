import { useEffect, useRef, useState } from 'preact/hooks';
import type { Rect } from '@annotate/shared';
import { isStableClass } from '../capture/anchor';

/** What the user picked: a DOM element (the default) or a drawn area. */
export type Picked = { mode: 'element'; element: Element } | { mode: 'area'; rect: Rect };

interface Props {
  /** The widget's shadow host; skipped when hit-testing the page. */
  host: HTMLElement;
  onSelect(picked: Picked): void;
  onCancel(): void;
}

/** Smallest drawn area that counts (px). */
const MIN_AREA_SIZE = 8;
/** Elements thinner than this in either direction are skipped in favor of their parent. */
const MIN_TARGET = 16;
/** Inline elements that are still worth picking on their own. */
const INLINE_OK = new Set(['img', 'a', 'button', 'input', 'select', 'textarea', 'svg', 'video']);
/** Pointer travel (px) that turns a press into a drag. */
const DRAG_THRESHOLD = 4;
/** Accumulated wheel delta (px) per parent/child step, and the minimum gap between steps. */
const WHEEL_STEP = 50;
const WHEEL_GAP_MS = 120;
const WHEEL_IDLE_MS = 250;
/** Snap rule: the box covers ≥80% of the element, and the element is ≤1.25× the box. */
const SNAP_COVER = 0.8;
const SNAP_MAX_RATIO = 1.25;

interface Drag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Started with Shift in element mode (a tiny drag then counts as a click). */
  shift: boolean;
  moved: boolean;
}

interface Target {
  el: Element;
  rect: Rect;
}

// ---------------------------------------------------------------------------
// Geometry and DOM helpers (exported for tests)

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
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

/** Big enough and not inline-only: a sensible thing to report on. body always qualifies. */
export function isMeaningful(el: Element): boolean {
  if (el === document.body) return true;
  const r = el.getBoundingClientRect();
  if (r.width < MIN_TARGET || r.height < MIN_TARGET) return false;
  if (INLINE_OK.has(el.localName)) return true;
  return getComputedStyle(el).display !== 'inline';
}

/** Topmost page element at a viewport point, skipping the widget. Never html; outside body → body. */
export function pageElementAt(x: number, y: number, host: Element): Element | null {
  if (typeof document.elementsFromPoint !== 'function') return null;
  for (const el of document.elementsFromPoint(x, y)) {
    if (el === host || host.contains(el)) continue;
    if (el === document.documentElement || !document.body.contains(el)) return document.body;
    return el;
  }
  return null;
}

/** From the hit element, walk up past tiny and inline-only elements. */
export function smartTarget(hit: Element): Element {
  const body = document.body;
  let cur: Element | null = hit;
  while (cur && cur !== body && !isMeaningful(cur)) cur = cur.parentElement;
  return cur ?? body;
}

/** The nearest meaningful ancestor, stopping at body. */
export function parentTarget(el: Element): Element {
  const body = document.body;
  if (el === body) return body;
  let cur: Element | null = el.parentElement;
  while (cur && cur !== body && !isMeaningful(cur)) cur = cur.parentElement;
  return cur && body.contains(cur) ? cur : body;
}

/** The first meaningful element below `target` on the way down to `hit` (the element under the cursor). */
export function childToward(target: Element, hit: Element | null): Element | null {
  if (!hit || hit === target || !target.contains(hit)) return null;
  const path: Element[] = [];
  for (let cur: Element | null = hit; cur && cur !== target; cur = cur.parentElement) path.push(cur);
  for (let i = path.length - 1; i >= 0; i--) if (isMeaningful(path[i]!)) return path[i]!;
  return null;
}

function area(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

function intersection(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Area → element snap. Candidates: the elements under the box's center and their ancestors.
 * One qualifies when the box covers ≥80% of it and it's at most 1.25× the box; the best overlap
 * wins, and on a tie the deepest (first found).
 */
export function snapTarget(box: Rect, host: Element): Element | null {
  const boxArea = area(box);
  if (boxArea <= 0 || typeof document.elementsFromPoint !== 'function') return null;
  const body = document.body;
  const html = document.documentElement;
  const seen = new Set<Element>();
  let best: Element | null = null;
  let bestScore = 0;
  for (const hit of document.elementsFromPoint(box.x + box.width / 2, box.y + box.height / 2)) {
    if (hit === host || host.contains(hit)) continue;
    for (let cur: Element | null = hit; cur && cur !== html; cur = cur.parentElement) {
      if (seen.has(cur)) break; // its ancestors were visited too
      seen.add(cur);
      if (cur !== body && !body.contains(cur)) break;
      const r = rectOf(cur);
      const a = area(r);
      if (a <= 0 || a > boxArea * SNAP_MAX_RATIO) continue;
      const inter = intersection(box, r);
      if (inter / a < SNAP_COVER) continue;
      const score = inter / (boxArea + a - inter);
      if (score > bestScore) {
        best = cur;
        bestScore = score;
      }
    }
  }
  return best;
}

/** Short human label: `h2.hero-title`, `section#services`. */
export function describeElement(el: Element): string {
  let s = el.localName;
  const id = el.id.trim();
  if (id && /^[A-Za-z_][\w-]*$/.test(id)) s += `#${id}`;
  else {
    const classes = Array.from(el.classList).filter(isStableClass).slice(0, 2);
    if (classes.length) s += `.${classes.join('.')}`;
  }
  return s.length > 48 ? `${s.slice(0, 47)}…` : s;
}

function sizeLabel(r: Rect): string {
  return `${Math.round(r.width)}×${Math.round(r.height)}`;
}

/** Where a label sits for a box: above it, else below, else inside its top edge; always on screen. */
function labelPos(r: Rect, text: string): { left: string; top: string } {
  const h = 20;
  const gap = 4;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = text.length * 6.6 + 14; // rough; 11px semibold
  let top = r.y - h - gap;
  if (top < gap) top = r.y + r.height + gap + h <= vh ? r.y + r.height + gap : Math.max(gap, r.y + gap);
  top = Math.min(Math.max(gap, top), vh - h - gap);
  const left = Math.min(Math.max(gap, r.x), Math.max(gap, vw - w - gap));
  // Preact 11 doesn't append px to numbers.
  return { left: `${left}px`, top: `${top}px` };
}

function boxStyle(r: Rect) {
  return { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` };
}

function isOwnButton(t: EventTarget | undefined): boolean {
  return t instanceof HTMLElement && t.tagName === 'BUTTON' && !!t.closest('.an-hint');
}

// ---------------------------------------------------------------------------

/**
 * Full-viewport picking overlay. Hover highlights the element under the cursor (drawn in the
 * shadow root; the page's styles are never touched). ↑/↓ or the wheel walk to the parent/child,
 * click or Enter picks, Esc cancels. Shift+drag or "Draw area" draws a box instead; a box that
 * closely matches an element snaps to it.
 */
export function Selector({ host, onSelect, onCancel }: Props) {
  const [areaMode, setAreaMode] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [snap, setSnap] = useState<Target | null>(null);

  const overlayRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<Element | null>(null);
  /** Raw element under the pointer (before the smart-target walk). */
  const hitRef = useRef<Element | null>(null);
  const pointRef = useRef<{ x: number; y: number } | null>(null);
  /** True once ↑/↓ changed the target: keep it while the pointer stays inside it. */
  const lockedRef = useRef(false);
  /** Elements we came up from with ↑, for ↓. */
  const stackRef = useRef<Element[]>([]);
  const dragRef = useRef<Drag | null>(null);
  const suppressClickRef = useRef(false);
  const frameRef = useRef(0);
  const wheelRef = useRef({ acc: 0, last: 0, step: 0 });
  const areaModeRef = useRef(areaMode);
  areaModeRef.current = areaMode;
  const propsRef = useRef({ host, onSelect, onCancel });
  propsRef.current = { host, onSelect, onCancel };

  const setTargetEl = (el: Element | null) => {
    targetRef.current = el;
    if (!el) {
      setTarget(null);
      return;
    }
    const rect = rectOf(el);
    setTarget((prev) => (prev && prev.el === el && sameRect(prev.rect, rect) ? prev : { el, rect }));
  };

  const refreshRect = () => setTargetEl(targetRef.current?.isConnected ? targetRef.current : null);

  const hover = (x: number, y: number) => {
    const hit = pageElementAt(x, y, propsRef.current.host);
    if (!hit) return;
    hitRef.current = hit;
    const cur = targetRef.current;
    if (lockedRef.current && cur?.isConnected && cur.contains(hit)) {
      refreshRect();
      return;
    }
    lockedRef.current = false;
    stackRef.current = [];
    setTargetEl(smartTarget(hit));
  };

  const updateDrag = () => {
    const d = dragRef.current;
    if (!d) return;
    setDrag({ ...d });
    const r = toRect(d);
    const el = d.moved && r.width >= MIN_AREA_SIZE && r.height >= MIN_AREA_SIZE ? snapTarget(r, propsRef.current.host) : null;
    setSnap(el ? { el, rect: rectOf(el) } : null);
  };

  const tick = () => {
    frameRef.current = 0;
    if (dragRef.current) updateDrag();
    else if (areaModeRef.current) return;
    else if (pointRef.current) hover(pointRef.current.x, pointRef.current.y);
    else refreshRect();
  };

  const schedule = () => {
    if (!frameRef.current) frameRef.current = requestAnimationFrame(tick);
  };

  const up = () => {
    const cur = targetRef.current;
    if (!cur || cur === document.body) return;
    stackRef.current.push(cur);
    lockedRef.current = true;
    setTargetEl(parentTarget(cur));
  };

  const down = () => {
    const cur = targetRef.current;
    if (!cur) return;
    const hit = hitRef.current;
    const stack = stackRef.current;
    while (stack.length) {
      const prev = stack.pop()!;
      if (prev.isConnected && prev !== cur && cur.contains(prev) && (!hit || prev.contains(hit))) {
        lockedRef.current = true;
        setTargetEl(prev);
        return;
      }
    }
    const child = childToward(cur, hit);
    if (child) {
      lockedRef.current = true;
      setTargetEl(child);
    }
  };

  const pickTarget = () => {
    const el = targetRef.current;
    if (el?.isConnected) propsRef.current.onSelect({ mode: 'element', element: el });
  };

  const finishArea = (rect: Rect) => {
    const snapped = snapTarget(rect, propsRef.current.host);
    if (snapped) propsRef.current.onSelect({ mode: 'element', element: snapped });
    else propsRef.current.onSelect({ mode: 'area', rect });
  };

  // Keyboard: Esc cancels, ↑/↓ adjust, Enter picks. Capture phase so the page doesn't scroll or react.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftHeld(e.type === 'keydown');
      if (e.type !== 'keydown') return;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === 'Escape') {
        stop();
        propsRef.current.onCancel();
        return;
      }
      if (areaModeRef.current || dragRef.current) return;
      if (e.key === 'ArrowUp') {
        stop();
        up();
      } else if (e.key === 'ArrowDown') {
        stop();
        down();
      } else if (e.key === 'Enter' && !isOwnButton(e.composedPath()[0])) {
        stop();
        pickTarget();
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, []);

  // Wheel walks parent/child; it never scrolls the page while picking. Not passive, so preventDefault works.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (areaModeRef.current || dragRef.current) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
      const delta = (e.deltaY || (e.shiftKey ? e.deltaX : 0)) * unit;
      if (!delta) return;
      const w = wheelRef.current;
      const now = performance.now();
      if (now - w.last > WHEEL_IDLE_MS || Math.sign(delta) !== Math.sign(w.acc)) w.acc = 0;
      w.last = now;
      w.acc += delta;
      if (Math.abs(w.acc) < WHEEL_STEP || now - w.step < WHEEL_GAP_MS) return;
      w.step = now;
      if (w.acc < 0) up();
      else down();
      w.acc = 0;
    };
    overlay.addEventListener('wheel', onWheel, { passive: false });
    return () => overlay.removeEventListener('wheel', onWheel);
  }, []);

  // Keep the highlight on the element through scrolls and resizes.
  useEffect(() => {
    const onChange = () => schedule();
    window.addEventListener('scroll', onChange, { capture: true, passive: true });
    window.addEventListener('resize', onChange, { passive: true });
    return () => {
      window.removeEventListener('scroll', onChange, { capture: true });
      window.removeEventListener('resize', onChange);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  const onPointerDown = (e: PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    e.preventDefault();
    suppressClickRef.current = false;
    pointRef.current = { x: e.clientX, y: e.clientY };
    if (areaModeRef.current || e.shiftKey) {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      dragRef.current = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, shift: !areaModeRef.current, moved: false };
      return;
    }
    // Touch has no hover: pick from where the finger landed.
    hover(e.clientX, e.clientY);
  };

  const onPointerMove = (e: PointerEvent) => {
    pointRef.current = { x: e.clientX, y: e.clientY };
    if (e.shiftKey !== shiftHeld && e.pointerType === 'mouse') setShiftHeld(e.shiftKey);
    const d = dragRef.current;
    if (d) {
      d.x1 = e.clientX;
      d.y1 = e.clientY;
      if (!d.moved && Math.hypot(d.x1 - d.x0, d.y1 - d.y0) >= DRAG_THRESHOLD) d.moved = true;
    }
    schedule();
  };

  const endDrag = () => {
    dragRef.current = null;
    setDrag(null);
    setSnap(null);
  };

  const onPointerUp = (e: PointerEvent) => {
    e.stopPropagation();
    const d = dragRef.current;
    if (!d) return;
    d.x1 = e.clientX;
    d.y1 = e.clientY;
    const rect = toRect(d);
    endDrag();
    if (d.moved && rect.width >= MIN_AREA_SIZE && rect.height >= MIN_AREA_SIZE) {
      suppressClickRef.current = true;
      finishArea(rect);
      return;
    }
    // A Shift+click (no real drag) picks the element like a plain click; in area mode it does nothing.
    if (!d.shift) suppressClickRef.current = true;
    else hover(e.clientX, e.clientY);
  };

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (areaModeRef.current) return;
    pickTarget();
  };

  const toggleArea = () => {
    endDrag();
    lockedRef.current = false;
    stackRef.current = [];
    setTargetEl(null);
    setAreaMode((v) => !v);
  };

  // Clicks on the pill's buttons must not reach the overlay's handlers.
  const shield = (e: Event) => e.stopPropagation();

  const box = drag?.moved ? toRect(drag) : null;
  const showHighlight = !areaMode && !box && target;
  const tag = target ? describeElement(target.el) : '';
  const hlText = target ? `${tag} · ${sizeLabel(target.rect)}` : '';
  const boxText = box ? (snap ? `${sizeLabel(box)} → ${describeElement(snap.el)}` : sizeLabel(box)) : '';

  return (
    <div
      ref={overlayRef}
      class={`an-selector ${areaMode ? 'an-area' : 'an-pick'}${shiftHeld ? ' an-shift' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={endDrag}
      onClick={onClick}
      data-annotate="selector"
    >
      {showHighlight && (
        <>
          <div class="an-pick-box" style={boxStyle(target.rect)} />
          <div class="an-pick-label" style={labelPos(target.rect, hlText)}>
            <span>{tag}</span>
            <span class="an-pick-dim"> · {sizeLabel(target.rect)}</span>
          </div>
        </>
      )}
      {box && snap && <div class="an-snap" style={boxStyle(snap.rect)} />}
      {box && <div class="an-box" style={boxStyle(box)} />}
      {box && (
        <div class="an-size" style={labelPos(box, boxText)}>
          {boxText}
        </div>
      )}
      {!box && (
        <div class="an-hint" onPointerDown={shield} onPointerUp={shield} onClick={shield}>
          {areaMode ? (
            <span>Drag to draw an area · Esc to cancel</span>
          ) : (
            <>
              <span class="an-hint-fine">Click an element · ↑↓ to adjust · Shift+drag to draw an area · Esc to cancel</span>
              <span class="an-hint-touch">Tap an element</span>
            </>
          )}
          <button type="button" class={areaMode ? 'an-on' : ''} aria-pressed={areaMode} onClick={toggleArea}>
            {areaMode ? 'Pick element' : 'Draw area'}
          </button>
          <button type="button" onClick={() => propsRef.current.onCancel()}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
