// Anchoring: remember where on the page an issue was reported, and find that spot again later.
import { finder } from '@medv/finder';
import type { Anchor, Rect } from '@annotate/shared';

/** Slack (px) when testing whether an element's box contains the selection. */
const TOLERANCE = 2;
/** Max length of Anchor.text. */
const TEXT_LEN = 80;
/** How much of Anchor.text must still be present for a selector match to count. */
const TEXT_CHECK_LEN = 20;
/** finder can explode combinatorially on deep, class-heavy DOMs; cap it. */
const FINDER_TIMEOUT_MS = 300;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function containsRect(box: Box, rect: Rect): boolean {
  return (
    box.left - TOLERANCE <= rect.x &&
    box.top - TOLERANCE <= rect.y &&
    box.left + box.width + TOLERANCE >= rect.x + rect.width &&
    box.top + box.height + TOLERANCE >= rect.y + rect.height
  );
}

export function normalizeText(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Selector filters

/** CSS-in-JS prefixes. The remainder counts as a hash if it has a digit or mixed case (sc-bdVaJa). */
const CSS_IN_JS_PREFIX = /^(?:css|sc|jsx|emotion|svelte)-(.+)$/;
/** WordPress block-editor state/layout classes that change between renders or page builds. */
const WP_UNSTABLE = /^(?:is-|has-|wp-container-|wp-elements-|wp-duotone-)/;
/** Runtime state classes that toggle with interaction. */
const STATE_CLASSES = new Set([
  'active', 'current', 'open', 'opened', 'closed', 'show', 'shown', 'hide', 'hidden', 'visible',
  'hover', 'focus', 'focused', 'selected', 'collapsed', 'expanded', 'loaded', 'loading', 'animated',
]);

/** A run of 5+ hex chars/digits that contains at least one digit (avoids flagging words like "faced"). */
function hasHexRun(name: string): boolean {
  const runs = name.match(/[0-9a-f]{5,}/gi);
  return !!runs && runs.some((r) => /\d/.test(r));
}

function looksHashed(rest: string): boolean {
  return /\d/.test(rest) || (/[a-z]/.test(rest) && /[A-Z]/.test(rest));
}

/** True if a class name is stable and meaningful enough to appear in a selector. */
export function isStableClass(name: string): boolean {
  // Tailwind variants/arbitrary values (md:flex, w-[13px], w-1/2), escapes, anything exotic.
  if (!/^-?[A-Za-z_][\w-]*$/.test(name)) return false;
  const css = CSS_IN_JS_PREFIX.exec(name);
  if (css && looksHashed(css[1]!)) return false;
  if (hasHexRun(name)) return false;
  // CSS-modules suffix: Button_primary__3xYz1 (but keep BEM like card__item2)
  const mod = /___?([\w-]{5,})$/.exec(name);
  if (mod && /\d/.test(mod[1]!) && (/[A-Z]/.test(mod[1]!) || /\d.*\d/.test(mod[1]!))) return false;
  if (WP_UNSTABLE.test(name)) return false;
  if (STATE_CLASSES.has(name)) return false;
  return true;
}

/** True if an id is stable enough to appear in a selector. */
export function isStableId(id: string): boolean {
  if (!/^[A-Za-z_][\w-]*$/.test(id)) return false; // React useId (:r1:), weird escapes
  if (/\d{3,}/.test(id)) return false; // post-1234, ember512, yui_3_5_1_1_1700000
  if (hasHexRun(id)) return false;
  return true;
}

/** Plain nth-of-type path from body, used when finder gives up. */
function pathSelector(el: Element): string | null {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    const tag = cur.tagName.toLowerCase();
    let index = 1;
    for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.tagName === cur.tagName) index++;
    }
    parts.unshift(`${tag}:nth-of-type(${index})`);
    cur = cur.parentElement;
  }
  if (cur !== document.body) return null;
  parts.unshift('body');
  return parts.join(' > ');
}

function selectorFor(el: Element): string | null {
  if (el === document.documentElement) return 'html';
  if (el === document.body) return 'body';
  let sel: string | null = null;
  try {
    sel = finder(el, {
      root: document.body,
      idName: isStableId,
      className: isStableClass,
      timeoutMs: FINDER_TIMEOUT_MS,
    });
  } catch {
    sel = null;
  }
  if (sel && safeQuery(sel) === el) return sel;
  const path = pathSelector(el);
  return path && safeQuery(path) === el ? path : null;
}

function safeQuery(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// createAnchor

function topHit(x: number, y: number, exclude: Element): Element | null {
  const hits = typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(x, y) : [];
  for (const el of hits) {
    if (el === exclude || exclude.contains(el)) continue;
    return el;
  }
  return null;
}

export function createAnchor(rect: Rect, exclude: Element): Anchor {
  const sx = window.scrollX;
  const sy = window.scrollY;
  const absolute: Rect = { x: rect.x + sx, y: rect.y + sy, width: rect.width, height: rect.height };
  const viewportWidth = window.innerWidth;

  const body = document.body;
  const html = document.documentElement;

  let el: Element | null = topHit(rect.x + rect.width / 2, rect.y + rect.height / 2, exclude) ?? body;
  // Something outside body (rare: html itself, or a node appended to <html>) → start from body.
  if (!el || (el !== html && !body.contains(el))) el = body;

  // Smallest ancestor (from the top hit up to body) whose box contains the whole selection.
  let found: Element | null = null;
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (cur === html) break;
    if (containsRect(boxOf(cur), rect)) {
      found = cur;
      break;
    }
    if (cur === body) break;
  }
  const anchorEl = found ?? html;

  const box = boxOf(anchorEl);
  const relative: Rect | null =
    box.width > 0 && box.height > 0
      ? {
          x: (rect.x - box.left) / box.width,
          y: (rect.y - box.top) / box.height,
          width: rect.width / box.width,
          height: rect.height / box.height,
        }
      : null;

  const selector = relative ? selectorFor(anchorEl) : null;

  return {
    mode: 'area',
    selector,
    relative: selector ? relative : null,
    absolute,
    viewportWidth,
    text: selector ? anchorText(anchorEl) : '',
  };
}

/** body/html text is the whole page (incl. inline scripts) and only adds false "detached" results. */
function anchorText(el: Element): string {
  if (el === document.body || el === document.documentElement) return '';
  return normalizeText(el.textContent).slice(0, TEXT_LEN);
}

// ---------------------------------------------------------------------------
// createElementAnchor (0.2)

/** Element mode: the anchor is exactly this element, so a pin always outlines its live rect. */
export function createElementAnchor(el: Element): Anchor {
  const r = el.getBoundingClientRect();
  const absolute: Rect = { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  const selector = selectorFor(el);
  return {
    mode: 'element',
    selector,
    relative: selector ? { x: 0, y: 0, width: 1, height: 1 } : null,
    absolute,
    viewportWidth: window.innerWidth,
    text: selector ? anchorText(el) : '',
  };
}

// ---------------------------------------------------------------------------
// resolveAnchor (split in two so the pin layer can cache the DOM lookup across scroll frames)

/**
 * Find the anchor's element if it still looks like the one that was captured:
 * the selector matches and, when text was recorded, the start of that text is still in it.
 * Layout-independent; the size check happens in rectForAnchor.
 */
export function matchAnchor(anchor: Anchor): Element | null {
  if (!anchor.selector || !anchor.relative) return null;
  const el = safeQuery(anchor.selector);
  if (!el) return null;
  const want = normalizeText(anchor.text).slice(0, TEXT_CHECK_LEN).trim();
  if (want && !normalizeText(el.textContent).includes(want)) return null;
  return el;
}

export interface ResolvedAnchor {
  /** Viewport coordinates. Meaningless when hidden. */
  rect: Rect;
  /** The element is gone (or its text changed): rect is the capture-time absolute position. */
  detached: boolean;
  /** The element is there but not visible at this screen size: don't draw a pin. */
  hidden: boolean;
}

function absoluteFallback(anchor: Anchor): Rect {
  const a = anchor.absolute;
  return { x: a.x - window.scrollX, y: a.y - window.scrollY, width: a.width, height: a.height };
}

/**
 * Viewport rect for an anchor given the result of matchAnchor (null → absolute fallback, detached).
 * Element mode: the element's current rect, exactly. Area mode (and pre-0.2 anchors with no mode):
 * the relative fractions mapped onto the element's current rect.
 */
export function rectForAnchor(anchor: Anchor, el: Element | null): ResolvedAnchor {
  const rel = anchor.relative;
  if (el && rel && el.isConnected) {
    if (isElementHidden(el)) return { rect: absoluteFallback(anchor), detached: false, hidden: true };
    const box = boxOf(el);
    if (anchor.mode === 'element') {
      return { rect: { x: box.left, y: box.top, width: box.width, height: box.height }, detached: false, hidden: false };
    }
    if (box.width > 0 && box.height > 0) {
      return {
        rect: {
          x: box.left + rel.x * box.width,
          y: box.top + rel.y * box.height,
          width: rel.width * box.width,
          height: rel.height * box.height,
        },
        detached: false,
        hidden: false,
      };
    }
  }
  return { rect: absoluteFallback(anchor), detached: true, hidden: false };
}

export function resolveAnchor(anchor: Anchor): ResolvedAnchor {
  return rectForAnchor(anchor, matchAnchor(anchor));
}

/**
 * 0.2: true when an element exists but isn't visible at the current screen size
 * (display:none on it or an ancestor, zero size, or visibility:hidden). Pins skip hidden anchors.
 */
export function isElementHidden(el: Element): boolean {
  if (!el.isConnected || el.getClientRects().length === 0) return true;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return true;
  const style = getComputedStyle(el);
  return style.visibility === 'hidden' || style.display === 'none';
}
