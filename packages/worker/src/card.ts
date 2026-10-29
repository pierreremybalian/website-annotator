// Trello text formatting: card name and description for a new issue, and widget comments.

import type { CaptureEnv, Comment, ConsoleEntry, CreateIssueMeta } from '@annotate/shared';
import type { TrelloComment } from './trello';

const VIA_WIDGET = /^\*\*(.+?)\*\* \(via widget\): ([\s\S]*)$/;

/** Name as it appears in a widget comment prefix; '*' and newlines would break parsing it back. */
export const commentAuthorName = (name: string) => name.replace(/[*\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Anonymous';

/** Trello comment text for a comment posted from the widget. */
export const widgetCommentText = (name: string, text: string) => `**${commentAuthorName(name)}** (via widget): ${text}`;

/** Map a Trello comment to the API shape, recognising comments posted from the widget. */
export function parseComment(tc: TrelloComment): Comment {
  const text = tc.data?.text ?? '';
  const m = VIA_WIDGET.exec(text);
  if (m) return { id: tc.id, author: m[1]!, text: m[2]!, createdAt: tc.date, viaWidget: true };
  const author = tc.memberCreator?.fullName || tc.memberCreator?.username || 'Trello user';
  return { id: tc.id, author, text, createdAt: tc.date, viaWidget: false };
}

/** Trello allows 16384; stay comfortably below. */
export const MAX_DESC = 16000;
const TITLE_FALLBACK_LEN = 80;

const truncate = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/** The issue title: the reporter's title, or the first line of the notes truncated to 80 chars. */
export function issueTitle(title: string, notes: string): string {
  const t = title.trim();
  if (t) return t;
  const firstLine = notes.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  return truncate(firstLine, TITLE_FALLBACK_LEN);
}

export function cardName(number: number, title: string, notes: string): string {
  return `#${number} ${issueTitle(title, notes)}`;
}

const escapeLinkText = (s: string) => s.replace(/([\\[\]])/g, '\\$1');
const escapeLinkUrl = (s: string) => s.replace(/\s/g, (ch) => encodeURIComponent(ch)).replace(/\(/g, '%28').replace(/\)/g, '%29');
const unfence = (s: string) => s.replace(/```/g, "'''");

function envLine(env: CaptureEnv): string {
  const parts = [env.browser || 'Unknown browser', env.os || 'Unknown OS'];
  const w = env.viewport?.width;
  const h = env.viewport?.height;
  if (Number.isFinite(w) && Number.isFinite(h)) {
    const dpr = Number.isFinite(env.dpr) ? `${Number(env.dpr.toFixed(2))}` : '1';
    parts.push(`${w}×${h} @${dpr}x`);
  }
  return parts.join(' · ');
}

function formatConsoleEntry(e: ConsoleEntry): string {
  const head = `[${e.kind}] ${truncate(String(e.message ?? ''), 1000)}`;
  return unfence(e.stack ? `${head}\n${truncate(String(e.stack), 2000)}` : head);
}

/**
 * Markdown card description:
 *   notes, ---, Page / Reporter / Env lines, and when there are console errors a count plus a
 *   fenced code block with them (Trello markdown has no <details>). Kept under MAX_DESC chars.
 */
export function cardDescription(meta: CreateIssueMeta): string {
  const { env, reporter } = meta;
  const pageTitle = truncate((env.title ?? '').trim(), 200) || env.url;
  const lines = [
    meta.notes.trim(),
    '',
    '---',
    `**Page:** [${escapeLinkText(pageTitle)}](${escapeLinkUrl(env.url)})`,
    `**Reporter:** ${reporter.name.trim()} <${reporter.email.trim()}>`,
    `**Env:** ${envLine(env)}`,
  ];
  let desc = lines.join('\n');

  const errors = Array.isArray(env.consoleErrors) ? env.consoleErrors : [];
  if (errors.length) {
    const header = `\n**Console errors:** ${errors.length}\n\`\`\`\n`;
    const footer = '\n```';
    // Room left for entries, with slack for an "omitted" note.
    let budget = MAX_DESC - desc.length - header.length - footer.length - 40;
    const kept: string[] = [];
    // Most recent errors are last; keep the newest that fit, in their original order.
    for (let i = errors.length - 1; i >= 0; i--) {
      const entry = formatConsoleEntry(errors[i]!);
      if (entry.length + 1 > budget) break;
      kept.unshift(entry);
      budget -= entry.length + 1;
    }
    const omitted = errors.length - kept.length;
    if (omitted) kept.unshift(`(${omitted} older error${omitted === 1 ? '' : 's'} omitted)`);
    desc += header + kept.join('\n') + footer;
  }

  return desc.length > MAX_DESC ? `${desc.slice(0, MAX_DESC - 1)}…` : desc;
}
