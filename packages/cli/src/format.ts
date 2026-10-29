import type { IssueStatus } from '@annotate/shared';
import type { Out } from './context';

export interface Style {
  enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  blue(s: string): string;
  magenta(s: string): string;
  cyan(s: string): string;
}

/** Color only on a TTY; NO_COLOR (non-empty) and TERM=dumb turn it off. */
export function colorEnabled(out: Out, env: Record<string, string | undefined>): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  return out.isTTY === true;
}

export function makeStyle(enabled: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (enabled && s ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    magenta: wrap(35, 39),
    cyan: wrap(36, 39),
  };
}

export function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return Array.from(s.replace(/\x1b\[[0-9;]*m/g, '')).length;
}

export function padEnd(s: string, width: number): string {
  const n = visibleLength(s);
  return n >= width ? s : s + ' '.repeat(width - n);
}

const STATUS_LABEL: Record<IssueStatus, string> = {
  new: 'new',
  in_progress: 'in progress',
  review: 'review',
  resolved: 'resolved',
  archived: 'archived',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status as IssueStatus] ?? status;
}

export function colorStatus(style: Style, status: string, text = statusLabel(status)): string {
  switch (status) {
    case 'new':
      return style.yellow(text);
    case 'in_progress':
      return style.cyan(text);
    case 'review':
      return style.magenta(text);
    case 'resolved':
      return style.green(text);
    case 'archived':
      return style.dim(text);
    default:
      return text;
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "2026-10-28 13:20" in local time; '' for missing or invalid input. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${localDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "14:05" when it's today, else "2026-10-29 14:05". */
export function fmtWhen(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return localDate(d) === localDate(new Date(now)) ? time : `${localDate(d)} ${time}`;
}

/** Path + query of a page URL ("/about?x=1"); the raw string if it doesn't parse. */
export function pagePath(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname || '/') + u.search;
  } catch {
    return url;
  }
}

export interface Column<T> {
  header: string;
  get(row: T): string;
  color?(row: T, text: string): string;
  /** Truncate to this many characters. */
  max?: number;
}

/** Plain, space-separated table. The last column isn't padded. */
export function table<T>(rows: T[], columns: Column<T>[], style: Style): string[] {
  const cells = rows.map((row) => columns.map((c) => (c.max ? truncate(c.get(row), c.max) : c.get(row))));
  const widths = columns.map((c, i) => Math.max(visibleLength(c.header), ...cells.map((r) => visibleLength(r[i] ?? ''))));
  const last = columns.length - 1;
  const line = (parts: string[]) => parts.join('  ').replace(/\s+$/, '');
  const header = line(columns.map((c, i) => (i === last ? style.dim(c.header) : style.dim(padEnd(c.header, widths[i] ?? 0)))));
  const body = rows.map((row, r) =>
    line(
      columns.map((c, i) => {
        const text = cells[r]?.[i] ?? '';
        const padded = i === last ? text : padEnd(text, widths[i] ?? 0);
        // Color the text, keep the padding plain.
        return c.color ? c.color(row, text) + padded.slice(text.length) : padded;
      }),
    ),
  );
  return [header, ...body];
}

/** Join "key: value" pieces into lines no wider than `width`. */
export function wrapPieces(pieces: string[], width: number, sep = ' · '): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (!cur) cur = p;
    else if (visibleLength(cur) + sep.length + visibleLength(p) > width) {
      lines.push(cur);
      cur = p;
    } else cur += sep + p;
  }
  if (cur) lines.push(cur);
  return lines;
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * Element HTML for the terminal: dedented, long single-line markup split into one tag per line
 * (indented by depth), each line capped, about `maxLines` lines in all.
 */
export function trimHtml(html: string, maxLines = 40, maxWidth = 160): string[] {
  let lines = html.replace(/\r\n?/g, '\n').split('\n');
  if (lines.some((l) => l.length > 200)) {
    lines = indentTags(html.replace(/\s*\n\s*/g, ' ').replace(/>\s*</g, '>\n<').split('\n'));
  } else {
    const rest = lines.slice(1).filter((l) => l.trim());
    const indent = rest.length ? Math.min(...rest.map((l) => /^[ \t]*/.exec(l)?.[0].length ?? 0)) : 0;
    lines = [lines[0] ?? '', ...lines.slice(1).map((l) => l.slice(indent))];
  }
  lines = lines.map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  lines = lines.map((l) => truncate(l, maxWidth));
  if (lines.length > maxLines) {
    const more = lines.length - (maxLines - 1);
    lines = [...lines.slice(0, maxLines - 1), `… ${more} more lines (--json has the full HTML)`];
  }
  return lines;
}

function indentTags(lines: string[]): string[] {
  let depth = 0;
  return lines.map((raw) => {
    const l = raw.trim();
    if (l.startsWith('</')) depth = Math.max(0, depth - 1);
    const out = '  '.repeat(depth) + l;
    const open = /^<([a-zA-Z][\w-]*)/.exec(l);
    if (open && !l.endsWith('/>')) {
      const tag = (open[1] ?? '').toLowerCase();
      if (!VOID_TAGS.has(tag) && !l.includes(`</${tag}`)) depth++;
    }
    return out;
  });
}
