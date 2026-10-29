import type { CaptureEnv, ConsoleEntry } from '@annotate/shared';

const MAX_ERRORS = 20;
const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;

const own: ConsoleEntry[] = [];
let installed = false;

function push(entry: ConsoleEntry): void {
  own.push(entry);
  if (own.length > MAX_ERRORS) own.splice(0, own.length - MAX_ERRORS);
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function stackOf(value: unknown): string | undefined {
  return value instanceof Error && value.stack ? clip(value.stack, MAX_STACK) : undefined;
}

/**
 * Starts collecting console errors. Call once at bootstrap (not at capture time) so errors
 * raised before the user opens the widget are kept.
 */
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (e: ErrorEvent) => {
    // Resource load errors don't bubble to window, so this only sees script errors.
    // Keep message = e.message (like the head catcher) so the two lists dedupe.
    const where = e.filename ? `    at ${e.filename}:${e.lineno}:${e.colno}` : undefined;
    push({
      kind: 'error',
      message: clip(e.message || describe(e.error), MAX_MESSAGE),
      stack: stackOf(e.error) ?? where,
      at: Date.now(),
    });
  });

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    push({
      kind: 'unhandledrejection',
      message: clip(describe(e.reason), MAX_MESSAGE),
      stack: stackOf(e.reason),
      at: Date.now(),
    });
  });

  const original = console.error;
  console.error = function (this: Console, ...args: unknown[]) {
    try {
      const err = args.find((a) => a instanceof Error);
      push({
        kind: 'console.error',
        message: clip(args.map(describe).join(' '), MAX_MESSAGE),
        stack: stackOf(err),
        at: Date.now(),
      });
    } catch {
      /* never break the page's logging */
    }
    return original.apply(this, args as []);
  };
}

/**
 * The early buffer from the WP plugin's head catcher, merged with what we collected.
 * The head catcher may still be active after we install ours, so the same error can show
 * up in both lists: entries of the same kind within 100ms whose messages match (or one
 * prefixes the other, since catchers truncate differently) are merged.
 */
export function getConsoleErrors(): ConsoleEntry[] {
  const early = Array.isArray(window.__annotateErrors) ? window.__annotateErrors : [];
  const all = [...early, ...own]
    .filter((e) => e && typeof e.message === 'string')
    .sort((a, b) => (a.at || 0) - (b.at || 0));
  const out: ConsoleEntry[] = [];
  for (const e of all) {
    const dup = out.some(
      (o) =>
        o.kind === e.kind &&
        (o.message.startsWith(e.message) || e.message.startsWith(o.message)) &&
        Math.abs((o.at || 0) - (e.at || 0)) < 100,
    );
    if (!dup) out.push({ kind: e.kind, message: e.message, ...(e.stack ? { stack: e.stack } : {}), at: e.at });
  }
  return out.slice(-MAX_ERRORS);
}

export function parseUserAgent(ua: string, maxTouchPoints = 0): { browser: string; os: string } {
  const major = (re: RegExp) => ua.match(re)?.[1];
  let browser = 'Unknown';
  let v: string | undefined;
  if ((v = major(/Edg(?:e|A|iOS)?\/(\d+)/))) browser = `Edge ${v}`;
  else if ((v = major(/(?:OPR|Opera)\/(\d+)/))) browser = `Opera ${v}`;
  else if ((v = major(/(?:Firefox|FxiOS)\/(\d+)/))) browser = `Firefox ${v}`;
  else if ((v = major(/SamsungBrowser\/(\d+)/))) browser = `Samsung Internet ${v}`;
  else if ((v = major(/(?:Chrome|CriOS)\/(\d+)/))) browser = `Chrome ${v}`;
  else if (/Safari\//.test(ua) && (v = major(/Version\/(\d+(?:\.\d+)?)/))) browser = `Safari ${v}`;
  else if (/Safari\//.test(ua)) browser = 'Safari';

  let os = 'Unknown';
  if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Macintosh|Mac OS X/.test(ua)) os = maxTouchPoints > 1 ? 'iOS' : 'macOS'; // iPadOS sends a Mac UA
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return { browser, os };
}

export function buildEnv(): CaptureEnv {
  const ua = navigator.userAgent;
  const { browser, os } = parseUserAgent(ua, navigator.maxTouchPoints || 0);
  return {
    url: location.href,
    title: document.title,
    referrer: document.referrer,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    dpr: window.devicePixelRatio || 1,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    userAgent: ua,
    browser,
    os,
    language: navigator.language,
    timestamp: new Date().toISOString(),
    consoleErrors: getConsoleErrors(),
  };
}
