// Context capture (0.2): enough about the picked element for a person or a coding agent to find
// it in the source. Platform-agnostic; adapters add hints as data-* attributes and window.AnnotateContext.
import type { ElementContext, IssueContext, PageContext, SourceHint } from '@annotate/shared';
import { normalizeText } from './anchor';

const HTML_MAX = 3000;
const TEXT_MAX = 200;
const LANDMARK_MAX = 120;
const SOURCES_MAX = 10;
const PAGE_MAX_BYTES = 4096;
/** How far back the preceding-heading search walks before giving up. */
const HEADING_SCAN_MAX = 4000;

const HOST_TAG = 'annotate-widget';
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Elements whose text content is code or markup, not page text. */
const NON_TEXT = new Set(['script', 'style', 'noscript', 'template']);
const LANDMARK_TAGS = new Set(['section', 'article', 'main', 'header', 'footer', 'nav', 'aside']);
const HEADING = /^h[1-6]$/;
/** data-annotate-source values ending in one of these are file paths even without a '/'. */
const SOURCE_EXT =
  /\.(?:astro|tsx?|jsx?|mjs|cjs|vue|svelte|php|html?|twig|liquid|njk|hbs|handlebars|erb|mdx?|css|scss|sass|less|py|rb|go|rs)$/i;
const STYLE_PROPS = [
  'display', 'position', 'width', 'height', 'margin', 'padding', 'font-size', 'font-weight', 'line-height', 'color',
  'background-color', 'overflow',
] as const;

export function captureContext(el: Element | null): IssueContext {
  let element: ElementContext | null = null;
  if (el) {
    try {
      element = elementContext(el);
    } catch {
      element = null;
    }
  }
  return { page: readPageContext(), element };
}

export function elementContext(el: Element): ElementContext {
  return {
    tag: el.localName,
    html: sanitizedHtml(el, HTML_MAX),
    text: visibleText(el, TEXT_MAX),
    landmark: findLandmark(el),
    styles: keyStyles(el),
    sources: findSources(el),
  };
}

// ---------------------------------------------------------------------------
// HTML

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');
}

/** Attributes that carry what a user typed or chose, never captured. */
function dropAttr(tag: string, name: string): boolean {
  if (name === 'value') return tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'option';
  return name === 'selected' && tag === 'option';
}

/**
 * outerHTML-like serialization that stops once `max` chars are written, so a huge element
 * (body, a long section) costs no more than a small one. Leaves out script/style contents,
 * form values (value attributes, textarea text, selected options), comments and the widget.
 * Whitespace runs in text collapse to one space.
 */
export function sanitizedHtml(root: Element, max: number): string {
  let out = '';
  const full = () => out.length >= max;

  const walk = (node: Node): void => {
    if (full()) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.nodeValue ?? '').replace(/\s+/g, ' ');
      if (text) out += escapeText(text);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.localName;
    if (tag === HOST_TAG) return;
    out += `<${tag}`;
    for (const attr of Array.from(el.attributes)) {
      if (dropAttr(tag, attr.name)) continue;
      out += attr.value === '' ? ` ${attr.name}` : ` ${attr.name}="${escapeAttr(attr.value)}"`;
    }
    out += '>';
    if (VOID.has(tag)) return;
    if (tag !== 'script' && tag !== 'style' && tag !== 'textarea') {
      const kids = tag === 'template' ? (el as HTMLTemplateElement).content?.childNodes : el.childNodes;
      if (kids) for (const child of Array.from(kids)) walk(child);
    }
    if (!full()) out += `</${tag}>`;
  };

  walk(root);
  return out.length > max ? out.slice(0, max) : out;
}

/** textContent without script/style/template text or the widget, whitespace-collapsed, max `max` chars. */
export function visibleText(root: Element, max: number): string {
  let out = '';
  const walk = (node: Node): void => {
    if (out.length > max * 2) return;
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).localName;
    if (NON_TEXT.has(tag) || tag === HOST_TAG) return;
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(root);
  return normalizeText(out).slice(0, max);
}

// ---------------------------------------------------------------------------
// Landmark

function isLandmark(el: Element): boolean {
  return LANDMARK_TAGS.has(el.localName) || el.hasAttribute('role');
}

/**
 * The closest section/article/main/header/footer/nav/aside/[role] that has an aria-label or id
 * (e.g. `nav "Primary"`, `section#services`), else the nearest preceding h1–h6's text.
 */
export function findLandmark(el: Element): string | null {
  for (let cur: Element | null = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
    if (!isLandmark(cur)) continue;
    const label = normalizeText(cur.getAttribute('aria-label'));
    if (label) return `${cur.localName} "${label}"`.slice(0, LANDMARK_MAX);
    const id = cur.id.trim();
    if (id) return `${cur.localName}#${id}`.slice(0, LANDMARK_MAX);
  }
  return precedingHeading(el);
}

/** The element before `node` in document order (reverse preorder), staying below `root`. */
function previousElement(node: Element, root: Element): Element | null {
  let sib = node.previousElementSibling;
  if (sib) {
    while (sib.lastElementChild) sib = sib.lastElementChild;
    return sib;
  }
  const parent = node.parentElement;
  return parent && parent !== root ? parent : null;
}

/** Nearest h1–h6 before `el` in document order (an enclosing heading counts). */
function precedingHeading(el: Element): string | null {
  const body = document.body;
  if (!body || el === body || !body.contains(el)) return null;
  let cur: Element | null = el;
  for (let i = 0; i < HEADING_SCAN_MAX && cur; i++) {
    cur = previousElement(cur, body);
    if (cur && HEADING.test(cur.localName)) {
      const text = visibleText(cur, LANDMARK_MAX);
      if (text) return text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Styles

/** Four longhands → CSS shorthand order, collapsed like the browser does ("0px", "8px 16px", ...). */
function shorthand(top: string, right: string, bottom: string, left: string): string {
  if (left === right) {
    if (top === bottom) return top === right ? top : `${top} ${right}`;
    return `${top} ${right} ${bottom}`;
  }
  return `${top} ${right} ${bottom} ${left}`;
}

export function keyStyles(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  let cs: CSSStyleDeclaration;
  try {
    cs = getComputedStyle(el);
  } catch {
    return out;
  }
  const get = (p: string) => cs.getPropertyValue(p).trim();
  for (const prop of STYLE_PROPS) {
    let value: string;
    if (prop === 'margin' || prop === 'padding') {
      // Shorthands aren't reliably serialized from computed styles in every browser.
      const sides = ['top', 'right', 'bottom', 'left'].map((s) => get(`${prop}-${s}`));
      value = sides.every(Boolean) ? shorthand(sides[0]!, sides[1]!, sides[2]!, sides[3]!) : get(prop);
    } else if (prop === 'overflow') {
      const x = get('overflow-x');
      const y = get('overflow-y');
      value = x && y ? (x === y ? x : `${x} ${y}`) : get(prop);
    } else {
      value = get(prop);
    }
    if (value) out[prop] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source hints

function looksLikePath(value: string): boolean {
  return value.includes('/') || SOURCE_EXT.test(value);
}

/** Hints on one element, in SourceHint kind order. */
function hintsOn(el: Element, depth: number): SourceHint[] {
  const out: SourceHint[] = [];
  const annotate = el.getAttribute('data-annotate-source')?.trim();
  if (annotate) out.push({ kind: 'annotate', value: annotate, ...(looksLikePath(annotate) ? { file: annotate } : {}), depth });

  const block = el.getAttribute('data-annotate-block')?.trim();
  if (block) out.push({ kind: 'wp-block', value: block, depth });

  const astroFile = el.getAttribute('data-astro-source-file')?.trim();
  if (astroFile) {
    const hint: SourceHint = { kind: 'astro-source', value: astroFile, file: astroFile, depth };
    const line = Number.parseInt((el.getAttribute('data-astro-source-loc') ?? '').split(':')[0] ?? '', 10);
    if (Number.isFinite(line) && line > 0) hint.line = line;
    out.push(hint);
  }

  for (const attr of Array.from(el.attributes)) {
    if (!attr.name.startsWith('data-astro-cid-')) continue;
    const hash = attr.name.slice('data-astro-cid-'.length);
    if (hash) out.push({ kind: 'astro-cid', value: hash, depth });
  }
  return out;
}

/** Source hints from the element up to <html>, nearest first, deduped by kind + value, max 10. */
export function findSources(el: Element): SourceHint[] {
  const out: SourceHint[] = [];
  const seen = new Set<string>();
  let depth = 0;
  for (let cur: Element | null = el; cur && out.length < SOURCES_MAX; cur = cur.parentElement, depth++) {
    for (const hint of hintsOn(cur, depth)) {
      const key = `${hint.kind}\u0000${hint.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hint);
      if (out.length >= SOURCES_MAX) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Page context

let warned = false;

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[annotate] ${message}`);
}

/** Test hook: let the next invalid window.AnnotateContext warn again. */
export function resetPageContextWarning(): void {
  warned = false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** window.AnnotateContext as a JSON-safe copy, if it's a plain object of at most 4 KB as JSON. */
export function readPageContext(): PageContext | null {
  let raw: unknown;
  try {
    raw = window.AnnotateContext;
  } catch {
    return null;
  }
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    warnOnce('window.AnnotateContext must be a plain object; ignoring it.');
    return null;
  }
  let json: string;
  try {
    json = JSON.stringify(raw);
  } catch {
    warnOnce("window.AnnotateContext isn't JSON-serializable; ignoring it.");
    return null;
  }
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > PAGE_MAX_BYTES) {
    warnOnce(`window.AnnotateContext is ${bytes} bytes as JSON (max ${PAGE_MAX_BYTES}); ignoring it.`);
    return null;
  }
  return JSON.parse(json) as PageContext;
}
