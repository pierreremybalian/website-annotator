// Human-readable output. --json bypasses all of this.
import type { AgentIssue, AgentIssueDetail, AgentProject, Comment, IssueStatus } from '@annotate/shared';
import {
  colorStatus,
  fmtDateTime,
  fmtWhen,
  oneLine,
  pagePath,
  statusLabel,
  table,
  trimHtml,
  truncate,
  wrapPieces,
  type Style,
} from './format';
import type { ResolvedSource } from './sources';

const STATUSES: IssueStatus[] = ['new', 'in_progress', 'review', 'resolved', 'archived'];

export function activeClaim(issue: Pick<AgentIssue, 'claimedBy' | 'claimedUntil'>, now: number): string | null {
  if (!issue.claimedBy) return null;
  if (issue.claimedUntil && Date.parse(issue.claimedUntil) <= now) return null;
  return issue.claimedBy;
}

export function renderProject(p: AgentProject, style: Style, extra: { endpoint: string; configPath: string | null }): string[] {
  const counts = p.counts ?? ({} as Record<IssueStatus, number>);
  const label = (s: string) => style.dim(s.padEnd(9));
  return [
    `${style.bold(p.name)}  ${style.dim(`(${p.projectKey})`)}`,
    `${label('Board')}${p.boardName}  ${style.dim(p.boardUrl)}`,
    `${label('Origins')}${p.origins?.length ? p.origins.join(', ') : style.dim('none')}`,
    `${label('Issues')}${STATUSES.map((s) => `${colorStatus(style, s, String(counts[s] ?? 0))} ${statusLabel(s)}`).join(' · ')}`,
    `${label('Endpoint')}${extra.endpoint}`,
    `${label('Config')}${extra.configPath ?? style.dim('none (ANNOTATE_TOKEN)')}`,
  ];
}

export function emptyIssuesMessage(status: string | undefined, url: string | undefined): string {
  const base =
    !status || status === 'open'
      ? 'No open issues'
      : status === 'all'
        ? 'No issues'
        : status === 'review'
          ? 'No issues in review'
          : `No ${statusLabel(status)} issues`;
  return `${base}${url ? ` for ${url}` : ''}.`;
}

export function renderIssueTable(issues: AgentIssue[], style: Style, opts: { now: number; columns?: number }): string[] {
  const titleMax = opts.columns ? Math.max(20, Math.min(70, opts.columns - 60)) : 50;
  return table(
    issues,
    [
      { header: '#', get: (i) => `#${i.number}`, color: (_i, t) => style.bold(t) },
      { header: 'STATUS', get: (i) => statusLabel(i.status), color: (i, t) => colorStatus(style, i.status, t) },
      { header: 'TITLE', get: (i) => oneLine(i.title || i.notes || ''), max: titleMax },
      { header: 'PAGE', get: (i) => pagePath(i.pageUrl ?? ''), max: 32, color: (_i, t) => style.dim(t) },
      { header: 'CLAIMED', get: (i) => activeClaim(i, opts.now) ?? '', color: (_i, t) => style.cyan(t) },
    ],
    style,
  );
}

function indent(lines: string[], n = 2): string[] {
  const pad = ' '.repeat(n);
  return lines.map((l) => (l ? pad + l : l));
}

function commentVia(c: Comment): string {
  return c.via ?? (c.viaWidget ? 'widget' : 'trello');
}

function hintLabel(r: ResolvedSource): string {
  const h = r.hint;
  const depth = 'depth' in h && h.depth > 0 ? ` (${h.depth} up)` : '';
  return `${h.kind} ${h.value}${depth}`;
}

export function renderIssueDetail(
  issue: AgentIssueDetail,
  resolved: { sources: ResolvedSource[]; truncated: boolean; root: string; cwd: string },
  style: Style,
  opts: { now: number },
): string[] {
  const out: string[] = [];
  const section = (title: string) => {
    out.push('', style.bold(title));
  };
  const field = (label: string, value: string | null | undefined) => {
    if (value) out.push(`  ${style.dim(label.padEnd(10))}${value}`);
  };

  // Header and notes
  out.push(`${style.bold(`#${issue.number}`)} ${style.bold(oneLine(issue.title || ''))}`);
  const claim = activeClaim(issue, opts.now);
  const meta = [
    colorStatus(style, issue.status),
    claim ? `claimed by ${style.cyan(claim)}${issue.claimedUntil ? ` until ${fmtWhen(issue.claimedUntil, opts.now)}` : ''}` : null,
    issue.reporterName ? `reported by ${issue.reporterName} ${fmtDateTime(issue.createdAt)}` : fmtDateTime(issue.createdAt),
    issue.updatedAt && fmtDateTime(issue.updatedAt) !== fmtDateTime(issue.createdAt) ? `updated ${fmtDateTime(issue.updatedAt)}` : null,
  ].filter(Boolean) as string[];
  out.push(meta.join(style.dim(' · ')));
  const notes = (issue.notes || '').trim();
  if (notes) out.push('', ...indent(notes.split(/\r?\n/)));

  // Where
  section('Where');
  field('Page', issue.pageUrl || issue.env?.url);
  const env = issue.env;
  if (env?.viewport) {
    const reportedAt = issue.anchor?.viewportWidth && issue.anchor.viewportWidth !== env.viewport.width ? ` (picked at ${issue.anchor.viewportWidth}px)` : '';
    field('Viewport', `${env.viewport.width}×${env.viewport.height}${env.dpr && env.dpr !== 1 ? ` @${env.dpr}x` : ''}${reportedAt}`);
  }
  field('Selector', issue.selector ?? issue.anchor?.selector ?? null);
  field('Landmark', issue.context?.element?.landmark ?? null);
  if (resolved.sources.length) {
    out.push(`  ${style.dim('Sources')}${resolved.root !== resolved.cwd ? style.dim(`   (paths relative to ${resolved.root})`) : ''}`);
    for (const r of resolved.sources) {
      out.push(`    ${hintLabel(r)}`);
      if (r.files.length) out.push(...r.files.map((f) => `      ${style.cyan(f)}`));
      else out.push(`      ${style.dim('no local match')}`);
    }
    if (resolved.truncated) out.push(`    ${style.dim('(file search hit its limit; some matches may be missing)')}`);
  } else {
    out.push(`  ${style.dim('Sources'.padEnd(10))}${style.dim('none reported; grep the selector classes or the text')}`);
  }

  // Element
  const el = issue.context?.element;
  if (el) {
    section(`Element <${el.tag}>${el.text ? ` ${style.dim(`"${truncate(oneLine(el.text), 60)}"`)}` : ''}`);
    if (el.html) out.push(...indent(trimHtml(el.html)));
    const styles = Object.entries(el.styles ?? {}).map(([k, v]) => `${k}: ${v}`);
    if (styles.length) out.push(...indent(wrapPieces(styles, 100).map((l) => style.dim(l))));
  }

  // Environment and console errors
  if (env) {
    section('Environment');
    const envLine = [
      env.browser,
      env.os,
      env.viewport ? `${env.viewport.width}×${env.viewport.height}` : null,
      env.language,
      env.timestamp ? fmtDateTime(env.timestamp) : null,
    ].filter(Boolean);
    out.push(`  ${envLine.join(' · ')}`);
    const errors = env.consoleErrors ?? [];
    if (errors.length) {
      out.push(`  ${style.red(`Console errors (${errors.length})`)}`);
      const shown = errors.slice(-10);
      if (errors.length > shown.length) out.push(`    ${style.dim(`… ${errors.length - shown.length} earlier`)}`);
      for (const e of shown) out.push(`    ${style.dim(e.kind)} ${truncate(oneLine(e.message.split('\n')[0] ?? ''), 160)}`);
    } else {
      out.push(`  ${style.dim('No console errors')}`);
    }
  }

  // Comments
  const comments = issue.comments ?? [];
  if (comments.length) {
    section(`Comments (${comments.length})`);
    for (const c of comments) {
      out.push(`  ${style.bold(c.author)} ${style.dim(`via ${commentVia(c)} · ${fmtDateTime(c.createdAt)}`)}`);
      out.push(...indent((c.text || '').trim().split(/\r?\n/), 4));
    }
  }

  if (issue.resolution) {
    section('Resolution');
    out.push(...indent(issue.resolution.trim().split(/\r?\n/)));
  }

  out.push('');
  if (issue.shortUrl) out.push(`${style.dim('Trello'.padEnd(12))}${issue.shortUrl}`);
  out.push(`${style.dim('Screenshot'.padEnd(12))}annotate screenshot ${issue.number}  ${style.dim('(--context for the full viewport)')}`);
  return out;
}
