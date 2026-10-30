/**
 * Finds where an element actually landed in the rendered page copy.
 *
 * The screenshot is a re-render of the page (snapdom clones it into an SVG), cropped at the
 * live element's coordinates. Anything the clone lays out differently above the selection moves
 * everything below it: a root margin the clone drops (the WordPress admin bar's 32px), a page rule
 * that overrides a baked style, an offscreen subtree pruned out of a card that straddles the top
 * edge. Rather than chase each one, the element is rendered on its own and searched for in the
 * page render near where it should be; the crop is then moved by the offset found.
 */

/** RGBA pixels at 1 CSS px per pixel (ImageData's shape, so tests can build them by hand). */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Offset {
  dx: number;
  dy: number;
}

/** How far, in CSS px, the clone's layout is searched for drift. */
export const MAX_DRIFT_Y = 240;
export const MAX_DRIFT_X = 48;

/** Probe pixels at least this opaque are compared; the rest are the element's see-through parts. */
const MIN_ALPHA = 160;
const MIN_POINTS = 24;
const MAX_POINTS = 4000;
/**
 * The best match must stand out from the rest of the vertical scan: its mean per-pixel difference
 * (|ΔR|+|ΔG|+|ΔB|, 0–765) at most this share of the scan's median. A flat or repeating element
 * has no clear minimum and is left uncorrected.
 */
const MAX_SCORE_RATIO = 0.6;
/** Scores within this of the best are ties; the offset nearest zero wins, so a clean page stays put. */
const TIE = 1.02;

interface Point {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
}

function probePoints(probe: Pixels): Point[] {
  const all: Point[] = [];
  const { data, width, height } = probe;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3]! >= MIN_ALPHA) all.push({ x, y, r: data[i]!, g: data[i + 1]!, b: data[i + 2]! });
    }
  }
  if (all.length <= MAX_POINTS) return all;
  const step = all.length / MAX_POINTS;
  const out: Point[] = [];
  for (let k = 0; k < MAX_POINTS; k++) out.push(all[Math.floor(k * step)]!);
  return out;
}

/** Mean difference of the probe placed at (ox, oy) in the view; Infinity when too little of it is on screen. */
function score(view: Pixels, points: Point[], ox: number, oy: number): number {
  const { data, width, height } = view;
  let sum = 0;
  let n = 0;
  for (const p of points) {
    const x = ox + p.x;
    const y = oy + p.y;
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const i = (y * width + x) * 4;
    sum += Math.abs(data[i]! - p.r) + Math.abs(data[i + 1]! - p.g) + Math.abs(data[i + 2]! - p.b);
    n++;
  }
  return n >= Math.max(MIN_POINTS, points.length * 0.4) ? sum / n : Infinity;
}

/** Best offset in [from, to] along one axis (ties go to the offset nearest zero), and the median score. */
function scan(from: number, to: number, at: (d: number) => number): { d: number; s: number; median: number } {
  const scores: Array<{ d: number; s: number }> = [];
  let best = Infinity;
  for (let d = from; d <= to; d++) {
    const s = at(d);
    scores.push({ d, s });
    if (s < best) best = s;
  }
  let pick = { d: 0, s: Infinity };
  for (const c of scores) {
    if (c.s > best * TIE + 0.5) continue;
    if (Math.abs(c.d) < Math.abs(pick.d) || pick.s === Infinity) pick = c;
  }
  const finite = scores.map((c) => c.s).filter(Number.isFinite).sort((a, b) => a - b);
  const median = finite[Math.floor(finite.length / 2)] ?? Infinity;
  return { ...pick, median };
}

/**
 * Where `probe` (the element rendered alone) sits in `view` (the page render), relative to
 * `origin` (where the live page has it), in CSS px. Null when it can't be found with confidence:
 * the element is see-through, mostly off screen, or doesn't match anywhere nearby.
 */
export function findOffset(view: Pixels, probe: Pixels, origin: { x: number; y: number }): Offset | null {
  const points = probePoints(probe);
  if (points.length < MIN_POINTS) return null;
  const ox = Math.round(origin.x);
  const oy = Math.round(origin.y);

  // Layout drift is almost always vertical: scan y first, then x at that y, then settle y again.
  const y1 = scan(-MAX_DRIFT_Y, MAX_DRIFT_Y, (d) => score(view, points, ox, oy + d));
  // Strictly below: a flat box on a flat page scores 0 everywhere and stands out nowhere.
  if (!(y1.s < y1.median * MAX_SCORE_RATIO)) return null;
  const x1 = scan(-MAX_DRIFT_X, MAX_DRIFT_X, (d) => score(view, points, ox + d, oy + y1.d));
  const y2 = scan(y1.d - 3, y1.d + 3, (d) => score(view, points, ox + x1.d, oy + d));
  return { dx: x1.d, dy: y2.d };
}
