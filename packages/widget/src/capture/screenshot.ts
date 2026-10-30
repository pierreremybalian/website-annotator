import { snapdom } from '@zumer/snapdom';
import type { Rect } from '@annotate/shared';
import { findOffset, type Offset, type Pixels } from './drift';

export interface Screenshots {
  /** image/png, the selected rect at devicePixelRatio (capped at 2). */
  selection: Blob;
  /** image/jpeg, the visible viewport (max 1600px wide) with the selection outlined. */
  context: Blob;
  /** False when capture failed and both blobs are 1×1 placeholders. */
  ok: boolean;
  error?: string;
  /** snapdom degradation codes (e.g. "image-fallback", "iframe-cross-origin"). */
  warnings: string[];
}

const ACCENT = '#ff4f2b';
const MAX_CONTEXT_WIDTH = 1600;
const JPEG_QUALITY = 0.82;
const TIMEOUT_MS = 20000;

// 1×1 white pixels, used when capture fails so the issue can still be submitted.
const PLACEHOLDER_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const PLACEHOLDER_JPEG =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

function b64Blob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export function placeholderScreenshots(error: string): Screenshots {
  return {
    selection: b64Blob(PLACEHOLDER_PNG, 'image/png'),
    context: b64Blob(PLACEHOLDER_JPEG, 'image/jpeg'),
    ok: false,
    error,
    warnings: [],
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Screenshot timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`Could not encode ${type}`))), type, quality),
  );
}

function hideHost(host: HTMLElement): () => void {
  const value = host.style.getPropertyValue('display');
  const priority = host.style.getPropertyPriority('display');
  host.style.setProperty('display', 'none', 'important');
  return () => {
    if (value) host.style.setProperty('display', value, priority);
    else host.style.removeProperty('display');
  };
}

function pageBackground(): string {
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue;
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return '#ffffff';
}

/**
 * Renders what the user currently sees (the viewport) into a canvas at `dpr`.
 *
 * snapdom renders document.documentElement with clip:'viewport', which prunes offscreen
 * subtrees and positions fixed/sticky elements where they are on screen (rendering the
 * whole document instead paints a fixed header at the document top, so it would vanish
 * from a scrolled crop). The capture is then cropped from its viewBox to the exact
 * viewport using the clip window snapdom reports in result.meta.
 *
 * The page's own <style> elements are left out of the clone: snapdom bakes each element's
 * computed style into a class of its own, and the page's rules would otherwise re-apply on
 * top and win wherever they come later at equal specificity. A WordPress block's inline
 * `.cta-band { margin-bottom: 5rem }` beat the baked `mb-0` (its !important is lost), pushing
 * everything below it 80px down, so a footer selection cropped the area above it.
 */
function excluder(host: HTMLElement) {
  return (el: Element) => el === host || el.localName === 'annotate-widget' || el.localName === 'style';
}

async function renderViewport(host: HTMLElement, dpr: number) {
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  // snapdom works in the root element's own coordinates, which are the document's only when
  // <html> sits at its origin. WordPress's admin bar gives it margin-top: 32px, so the viewport
  // is located from the root's box, not from scrollX/scrollY.
  const root = document.documentElement.getBoundingClientRect();

  const result = await withTimeout(
    snapdom(document.documentElement, {
      clip: 'viewport',
      dpr,
      scale: 1,
      backgroundColor: pageBackground(),
      exclude: [excluder(host)],
      excludeMode: 'remove',
      embedFonts: 'auto',
    }),
    TIMEOUT_MS,
  );
  const { contentX, contentY, clip } = result.meta;
  const crop = {
    x: contentX + (-root.left - (clip ? clip.x : 0)),
    y: contentY + (-root.top - (clip ? clip.y : 0)),
    width: vw,
    height: vh,
  };
  const canvas = await withTimeout(result.toCanvas({ dpr, scale: 1, crop }), TIMEOUT_MS);
  const warnings = Array.from(new Set(result.warnings.map((w) => w.code)));
  return { canvas, vw, vh, warnings };
}

function pixelsOf(canvas: HTMLCanvasElement, width = canvas.width, height = canvas.height): Pixels {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * The reference element rendered on its own, transparent around it. Rasterized at the page
 * render's dpr and scaled down to 1 CSS px per pixel the same way, so text antialiases alike.
 */
async function renderProbe(el: Element, host: HTMLElement, dpr: number): Promise<Pixels> {
  const result = await withTimeout(
    snapdom(el, { dpr, scale: 1, exclude: [excluder(host)], excludeMode: 'remove', embedFonts: 'auto' }),
    TIMEOUT_MS,
  );
  const { contentX, contentY, w0, h0 } = result.meta;
  const crop = { x: contentX, y: contentY, width: w0, height: h0 };
  const canvas = await withTimeout(result.toCanvas({ dpr, scale: 1, crop }), TIMEOUT_MS);
  return pixelsOf(canvas, Math.max(1, Math.round(w0)), Math.max(1, Math.round(h0)));
}

/**
 * How far the page render drew `reference` from where the live page has it (see drift.ts).
 * Null when there's nothing to measure or it can't be found; the crop then stays as is.
 */
async function measureDrift(
  reference: Element,
  origin: Rect,
  host: HTMLElement,
  dpr: number,
  view: { canvas: HTMLCanvasElement; vw: number; vh: number },
): Promise<Offset | null> {
  // A huge reference (an area whose anchor is most of the page) costs a second full render for nothing.
  if (origin.width * origin.height > view.vw * view.vh * 2) return null;
  try {
    const probe = await renderProbe(reference, host, dpr);
    // Scale by the same factor both ways: the render can come back shorter than the viewport.
    const k = view.canvas.width / view.vw;
    return findOffset(pixelsOf(view.canvas, view.vw, Math.max(1, Math.round(view.canvas.height / k))), probe, origin);
  } catch {
    return null;
  }
}

function rectFrom(r: DOMRect): Rect {
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** Clamp the selection to the viewport, in CSS px. */
function clampRect(r: Rect, vw: number, vh: number): Rect {
  const x = Math.max(0, Math.min(r.x, vw));
  const y = Math.max(0, Math.min(r.y, vh));
  const width = Math.max(1, Math.min(r.x + r.width, vw) - x);
  const height = Math.max(1, Math.min(r.y + r.height, vh) - y);
  return { x, y, width, height };
}

function cropSelection(src: HTMLCanvasElement, r: Rect, k: number): Promise<Blob> {
  const sx = Math.round(r.x * k);
  const sy = Math.round(r.y * k);
  const sw = Math.max(1, Math.min(src.width - sx, Math.round(r.width * k)));
  const sh = Math.max(1, Math.min(src.height - sy, Math.round(r.height * k)));
  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  out.getContext('2d')!.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  return toBlob(out, 'image/png');
}

function drawContext(src: HTMLCanvasElement, r: Rect, vw: number): Promise<Blob> {
  const outW = Math.min(src.width, MAX_CONTEXT_WIDTH);
  const outH = Math.max(1, Math.round((src.height * outW) / src.width));
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, outW, outH);

  const k = outW / vw; // output px per CSS px
  const line = 3;
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = line;
  // Stroke just outside the selection so the selected pixels stay visible.
  ctx.strokeRect(r.x * k - line / 2, r.y * k - line / 2, r.width * k + line, r.height * k + line);
  return toBlob(out, 'image/jpeg', JPEG_QUALITY);
}

export interface CaptureOptions {
  /** CSS px added around `rect` for the selection crop (clamped to the viewport). Default 0. */
  padding?: number;
  /**
   * An element at the selection (the picked element, or an area's anchor). It is located in the
   * page render and the crop is moved by however far the render drew it from the live page.
   */
  reference?: Element | null;
}

/**
 * Captures the selection (PNG) and the viewport context (JPEG). Never throws: on failure it
 * returns 1×1 placeholders with ok=false so the user can still submit their notes.
 * `rect` is in viewport coordinates and may extend past the viewport (a picked element that's
 * partly scrolled out): the crop is its visible part plus `padding`, the context image outlines it.
 * The widget host is hidden while snapdom reads the page.
 */
export async function captureScreenshots(rect: Rect, host: HTMLElement, opts: CaptureOptions = {}): Promise<Screenshots> {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const reference = opts.reference && opts.reference.isConnected ? opts.reference : null;
  const origin = reference ? rectFrom(reference.getBoundingClientRect()) : null;
  const restore = hideHost(host);
  let rendered: Awaited<ReturnType<typeof renderViewport>>;
  let drift: Offset | null = null;
  try {
    rendered = await renderViewport(host, dpr);
    if (reference && origin) drift = await measureDrift(reference, origin, host, dpr, rendered);
  } catch (err) {
    restore();
    return placeholderScreenshots(err instanceof Error ? err.message : String(err));
  }
  restore();
  if (drift) rect = { ...rect, x: rect.x + drift.dx, y: rect.y + drift.dy };

  try {
    const { canvas, vw, vh, warnings } = rendered;
    const k = canvas.width / vw;
    const pad = Math.max(0, opts.padding ?? 0);
    const crop = clampRect(
      { x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 },
      vw,
      vh,
    );
    const [selection, context] = await Promise.all([cropSelection(canvas, crop, k), drawContext(canvas, rect, vw)]);
    return { selection, context, ok: true, warnings };
  } catch (err) {
    return placeholderScreenshots(err instanceof Error ? err.message : String(err));
  }
}
