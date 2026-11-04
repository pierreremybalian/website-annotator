// /app/o/:org: the org's projects (a client sees only theirs), with open counts, and "New project".

import { useState } from 'preact/hooks';
import type { AppOrg, AppProject, AppProjectsResponse } from '@annotate/shared';
import { api } from '../api';
import { href, Link, navigate } from '../router';
import { ErrorNote, Loading, useAsync } from '../ui';

function NewProject(props: { orgId: string; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [site, setSite] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      const origin = /^https?:\/\//.test(site.trim()) ? site.trim() : `https://${site.trim()}`;
      const p = await api<AppProject>(`/orgs/${props.orgId}/projects`, { body: { name, origins: [origin] } });
      navigate(href.settings(p.id));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form class="card form" onSubmit={submit}>
      <h2>New project</h2>
      <ErrorNote message={error} />
      <label class="field">
        <span>Name</span>
        <input type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Strauss Houses" required maxLength={100} autoFocus />
      </label>
      <label class="field">
        <span>Site address (where the widget runs)</span>
        <input type="text" value={site} onInput={(e) => setSite((e.target as HTMLInputElement).value)} placeholder="https://staging.example.com" required />
      </label>
      <div class="row-actions">
        <button class="btn btn-primary" type="submit" disabled={busy || !name.trim() || !site.trim()}>
          Create project
        </button>
        <button class="btn btn-quiet" type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const ProjectCard = ({ p }: { p: AppProject }) => (
  <Link href={href.board(p.id)} class="card project-card">
    <div class="project-head">
      <h3>{p.name}</h3>
      {p.trello ? <span class={`pill ${p.trello.revoked ? 'pill-warn' : ''}`}>{p.trello.revoked ? 'Trello disconnected' : 'Trello'}</span> : null}
    </div>
    <p class="muted small">{p.origins.map((o) => o.replace(/^https?:\/\//, '')).join(' · ') || 'No site address yet'}</p>
    <div class="counts">
      <span>
        <b>{p.counts.new}</b> new
      </span>
      <span>
        <b>{p.counts.in_progress}</b> in progress
      </span>
      <span>
        <b>{p.counts.review}</b> to review
      </span>
    </div>
  </Link>
);

export function ProjectsPage(props: { org: AppOrg | null; orgId: string }) {
  const projects = useAsync(() => api<AppProjectsResponse>(`/orgs/${props.orgId}/projects`), [props.orgId]);
  const [creating, setCreating] = useState(false);
  if (!props.org) return <main class="page">{projects.error ? <ErrorNote message={projects.error} /> : <Loading />}</main>;
  const canCreate = props.org.role !== 'client';
  return (
    <main class="page">
      <div class="page-head">
        <h1>Projects</h1>
        {canCreate && !creating ? (
          <button class="btn btn-primary" type="button" onClick={() => setCreating(true)}>
            New project
          </button>
        ) : null}
      </div>
      {creating ? <NewProject orgId={props.orgId} onCancel={() => setCreating(false)} /> : null}
      <ErrorNote message={projects.error} />
      {projects.data ? (
        projects.data.projects.length ? (
          <div class="grid">
            {projects.data.projects.map((p) => (
              <ProjectCard p={p} />
            ))}
          </div>
        ) : (
          <div class="empty">
            <p>{canCreate ? 'No projects yet. Create one for each site you collect feedback on.' : 'No projects shared with you yet.'}</p>
          </div>
        )
      ) : (
        <Loading />
      )}
    </main>
  );
}
