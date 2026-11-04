// The issue drawer: screenshots, notes, where it was reported, the conversation, and its status. Clients can
// confirm a fix or reopen with a note; everyone else moves it freely.

import { useEffect, useState } from 'preact/hooks';
import type { AppIssueDetail, AppIssueResponse, AppProject, IssueStatus } from '@annotate/shared';
import { api } from '../api';
import { ErrorNote, Loading, STATUS_LABEL, timeAgo, useAsync } from '../ui';

const STATUSES: IssueStatus[] = ['new', 'in_progress', 'review', 'resolved', 'archived'];
const VIA: Record<string, string> = { widget: 'via widget', agent: 'agent', trello: 'in Trello', app: '' };

function sourceLabel(s: AppIssueDetail['sources'][number]): string {
  if (s.kind === 'astro-cid') return `data-astro-cid-${s.value}`;
  if (s.kind === 'wp-block') return s.value;
  return s.file ? (s.line ? `${s.file}:${s.line}` : s.file) : s.value;
}

export function IssueDrawer(props: { issueId: string; project: AppProject; onChange: () => void; onClose: () => void }) {
  const issue = useAsync(() => api<AppIssueResponse>(`/issues/${props.issueId}`), [props.issueId]);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = props.project.role === 'client';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [props.onClose]);

  const run = async (fn: () => Promise<AppIssueResponse>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      issue.setData(() => r);
      props.onChange();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const setStatus = (status: IssueStatus, comment?: string) => run(() => api<AppIssueResponse>(`/issues/${props.issueId}`, { method: 'PATCH', body: { status, comment } }));
  const send = async (e: Event) => {
    e.preventDefault();
    if (await run(() => api<AppIssueResponse>(`/issues/${props.issueId}/comments`, { body: { text: reply } }))) setReply('');
  };
  const reopen = async () => {
    if (!reply.trim()) {
      setError("Say what's still wrong in the box below, then click Still broken.");
      return;
    }
    if (await setStatus('new', reply)) setReply('');
  };

  const i = issue.data?.issue;
  return (
    <>
      <div class="scrim" onClick={props.onClose} />
      <aside class="drawer" aria-label="Issue">
        <button type="button" class="drawer-close btn btn-quiet btn-small" onClick={props.onClose} aria-label="Close">
          ✕
        </button>
        {!i ? (
          issue.error ? <ErrorNote message={issue.error} /> : <Loading />
        ) : (
          <>
            <p class="muted small">
              #{i.number} · reported {timeAgo(i.createdAt)} by {i.reporterName}
              {i.reporterEmail ? <> &lt;{i.reporterEmail}&gt;</> : null}
            </p>
            <h2 class="drawer-title">{i.title}</h2>
            <div class="status-row">
              {client ? (
                <span class={`pill pill-${i.status}`}>{STATUS_LABEL[i.status]}</span>
              ) : (
                <select aria-label="Status" value={i.status} disabled={busy} onChange={(e) => void setStatus((e.target as HTMLSelectElement).value as IssueStatus)}>
                  {STATUSES.map((s) => (
                    <option value={s}>{STATUS_LABEL[s]}</option>
                  ))}
                </select>
              )}
              {i.claimedBy ? <span class="pill pill-agent">🤖 {i.claimedBy} is on it</span> : null}
              {i.shortUrl ? (
                <a href={i.shortUrl} target="_blank" rel="noopener" class="small">
                  Trello card ↗
                </a>
              ) : null}
            </div>
            {client && (i.status === 'review' || i.status === 'resolved') ? (
              <div class="row-actions">
                {i.status === 'review' ? (
                  <button class="btn btn-primary" type="button" disabled={busy} onClick={() => void setStatus('resolved', '✅ Confirmed fixed')}>
                    Looks good ✓
                  </button>
                ) : null}
                <button class="btn" type="button" disabled={busy} onClick={() => void reopen()}>
                  Still broken
                </button>
              </div>
            ) : null}
            <ErrorNote message={error} />
            <a href={i.contextUrl} target="_blank" rel="noopener" title="Open the whole screen">
              <img class="shot" src={i.screenshotUrl} alt="The reported area" />
            </a>
            <p class="notes">{i.notes}</p>
            <dl class="facts">
              <dt>Page</dt>
              <dd>
                <a href={i.pageUrl} target="_blank" rel="noopener">
                  {i.pageUrl.replace(/^https?:\/\//, '')}
                </a>
              </dd>
              <dt>Browser</dt>
              <dd>
                {i.env.browser} · {i.env.os} · {i.env.viewport.width}×{i.env.viewport.height}
              </dd>
              {i.sources.length ? (
                <>
                  <dt>Source</dt>
                  <dd>
                    {i.sources.slice(0, 3).map((s) => (
                      <code>{sourceLabel(s)}</code>
                    ))}
                  </dd>
                </>
              ) : null}
              {i.resolution ? (
                <>
                  <dt>Fix</dt>
                  <dd>{i.resolution}</dd>
                </>
              ) : null}
            </dl>
            <h3 class="section-label">Conversation</h3>
            <ol class="comments">
              {i.comments.map((c) => (
                <li class={`comment comment-${c.via ?? 'trello'}`}>
                  <div class="muted small">
                    <b>{c.author}</b> {VIA[c.via ?? 'trello']} · {timeAgo(c.createdAt)}
                  </div>
                  <p>{c.text}</p>
                </li>
              ))}
              {i.comments.length ? null : <li class="muted small">No comments yet.</li>}
            </ol>
            <form class="reply" onSubmit={send}>
              <textarea value={reply} onInput={(e) => setReply((e.target as HTMLTextAreaElement).value)} placeholder="Reply to the reporter and the team…" rows={3} maxLength={5000} />
              <button class="btn btn-primary" type="submit" disabled={busy || !reply.trim()}>
                Comment
              </button>
            </form>
          </>
        )}
      </aside>
    </>
  );
}
