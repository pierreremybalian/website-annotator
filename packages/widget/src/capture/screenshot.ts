import { snapdom } from '@zumer/snapdom';
import type { Rect } from '@annotate/shared';

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
async function renderViewport(host: HTMLElement, dpr: number) {
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const sx = window.scrollX;
  const sy = window.scrollY;

  const result = await withTimeout(
    snapdom(document.documentElement, {
      clip: 'viewport',
      dpr,
      scale: 1,
      backgroundColor: pageBackground(),
      exclude: [(el: Element) => el === host || el.localName === 'annotate-widget' || el.localName === 'style'],
      excludeMode: 'remove',
      embedFonts: 'auto',
    }),
    TIMEOUT_MS,
  );
  const { contentX, contentY, clip } = result.meta;
  const crop = {
    x: contentX + (sx - (clip ? clip.x : 0)),
    y: contentY + (sy - (clip ? clip.y : 0)),
    width: vw,
    height: vh,
  };
  const canvas = await withTimeout(result.toCanvas({ dpr, scale: 1, crop }), TIMEOUT_MS);
  const warnings = Array.from(new Set(result.warnings.map((w) => w.code)));
  return { canvas, vw, vh, warnings };
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
  const restore = hideHost(host);
  let rendered: Awaited<ReturnType<typeof renderViewport>>;
  try {
    rendered = await renderViewport(host, dpr);
  } catch (err) {
    restore();
    return placeholderScreenshots(err instanceof Error ? err.message : String(err));
  }
  restore();

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
