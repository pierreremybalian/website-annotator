// /app/p/:id: the project's board. Columns by status; drag a card to move it (or use the status menu in the
// issue drawer). Refreshes every 20 seconds while the tab is open, so agent and widget changes show up.

import { useEffect, useState } from 'preact/hooks';
import type { AppIssue, AppIssuesResponse, AppProject, IssueStatus } from '@annotate/shared';
import { api } from '../api';
import { useSession } from '../app';
import { href, Link, navigate } from '../router';
import { BOARD_COLUMNS, ErrorNote, Loading, STATUS_LABEL, timeAgo, useAsync, usePoll } from '../ui';
import { IssueDrawer } from './issue';

export function ProjectHeader(props: { project: AppProject; tab: 'board' | 'settings' }) {
  const p = props.project;
  return (
    <div class="page-head project-header">
      <div>
        <p class="crumb">
          <Link href={href.projects(p.orgId)}>Projects</Link> /
        </p>
        <h1>{p.name}</h1>
      </div>
      <nav class="tabs">
        <Link href={href.board(p.id)} class={props.tab === 'board' ? 'on' : ''}>
          Board
        </Link>
        {p.role !== 'client' ? (
          <Link href={href.settings(p.id)} class={props.tab === 'settings' ? 'on' : ''}>
            Settings
          </Link>
        ) : null}
        {p.trello ? (
          <a href={p.trello.boardUrl} target="_blank" rel="noopener" class={p.trello.revoked ? 'warn' : ''} title={p.trello.revoked ? 'The Trello connection needs to be renewed' : 'Synced with Trello'}>
            Trello ↗
          </a>
        ) : null}
      </nav>
    </div>
  );
}

function IssueCard(props: { issue: AppIssue; projectId: string; draggable: boolean; selected: boolean }) {
  const i = props.issue;
  return (
    <Link href={href.board(props.projectId, i.id)} class={`issue-card${props.selected ? ' selected' : ''}`}>
      <div
        class="issue-card-inner"
        draggable={props.draggable}
        onDragStart={(e) => {
          e.dataTransfer!.setData('text/x-annotate-issue', i.id);
          e.dataTransfer!.effectAllowed = 'move';
        }}
      >
        <img src={i.screenshotUrl} alt="" loading="lazy" />
        <div class="issue-card-body">
          <div class="issue-title">
            <span class="num">#{i.number}</span> {i.title}
          </div>
          <div class="muted small">
            {i.reporterName} · {timeAgo(i.createdAt)}
            {i.commentCount ? ` · 💬 ${i.commentCount}` : ''}
          </div>
          {i.claimedBy ? <div class="pill pill-agent">🤖 {i.claimedBy}</div> : null}
        </div>
      </div>
    </Link>
  );
}

export function BoardPage(props: { projectId: string; issueId: string | null }) {
  const { setOrg } = useSession();
  const project = useAsync(() => api<AppProject>(`/projects/${props.projectId}`), [props.projectId]);
  const [showArchived, setShowArchived] = useState(false);
  const issues = useAsync(() => api<AppIssuesResponse>(`/projects/${props.projectId}/issues?status=${showArchived ? 'all' : 'board'}`), [props.projectId, showArchived]);
  const [over, setOver] = useState<IssueStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePoll(() => void issues.reload(), 20_000);
  useEffect(() => {
    if (project.data) setOrg(project.data.orgId);
  }, [project.data?.orgId]);

  if (!project.data) return <main class="page">{project.error ? <ErrorNote message={project.error} /> : <Loading />}</main>;
  const p = project.data;
  const canMove = p.role !== 'client';
  const columns: IssueStatus[] = showArchived ? [...BOARD_COLUMNS, 'archived'] : BOARD_COLUMNS;

  const move = async (id: string, status: IssueStatus) => {
    const current = issues.data?.issues.find((i) => i.id === id);
    if (!current || current.status === status) return;
    setError(null);
    issues.setData((d) => d && { issues: d.issues.map((i) => (i.id === id ? { ...i, status, claimedBy: status === 'in_progress' ? i.claimedBy : null } : i)) });
    try {
      await api(`/issues/${id}`, { method: 'PATCH', body: { status } });
    } catch (err) {
      setError((err as Error).message);
    }
    await issues.reload();
  };

  return (
    <main class="page board-page">
      <ProjectHeader project={p} tab="board" />
      {p.trello?.revoked ? <p class="note note-warn">The Trello connection stopped working, so changes here aren't reaching the board. Reconnect Trello from the WordPress plugin or `annotate connect`.</p> : null}
      <ErrorNote message={error ?? issues.error} />
      <div class="board-tools">
        <label class="check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived((e.target as HTMLInputElement).checked)} /> Show archived
        </label>
      </div>
      {issues.data ? (
        <div class="board" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(240px, 1fr))` }}>
          {columns.map((status) => {
            const list = issues.data!.issues.filter((i) => i.status === status);
            return (
              <section
                class={`column${over === status ? ' over' : ''}`}
                aria-label={STATUS_LABEL[status]}
                onDragOver={(e) => {
                  if (!canMove) return;
                  e.preventDefault();
                  setOver(status);
                }}
                onDragLeave={() => setOver((o) => (o === status ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  const id = e.dataTransfer?.getData('text/x-annotate-issue');
                  if (id) void move(id, status);
                }}
              >
                <h2 class="column-head">
                  <span class={`dot dot-${status}`} />
                  {STATUS_LABEL[status]} <span class="muted">{list.length}</span>
                </h2>
                <div class="column-body">
                  {list.map((i) => (
                    <IssueCard issue={i} projectId={p.id} draggable={canMove} selected={i.id === props.issueId} />
                  ))}
                  {list.length ? null : <p class="column-empty">{status === 'new' ? 'New reports from the widget land here.' : 'Nothing here.'}</p>}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <Loading />
      )}
      {issues.data && !issues.data.issues.length ? (
        <div class="empty">
          <p>No issues yet. Install the widget on the site{canMove ? <> (see <Link href={href.settings(p.id)}>Settings</Link>)</> : ''}, then report one from the page.</p>
        </div>
      ) : null}
      {props.issueId ? <IssueDrawer issueId={props.issueId} project={p} onChange={() => void issues.reload()} onClose={() => navigate(href.board(p.id))} /> : null}
    </main>
  );
}
