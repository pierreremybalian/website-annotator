// /app/p/:id/settings: installing the widget, where it may run, agent keys, and deleting the project.

import { useEffect, useState } from 'preact/hooks';
import type { AppAgentTokensResponse, AppNewAgentTokenResponse, AppProject } from '@annotate/shared';
import { ACTIVATION_PARAM } from '@annotate/shared';
import { api } from '../api';
import { useSession } from '../app';
import { href, navigate } from '../router';
import { CopyButton, ErrorNote, Loading, timeAgo, useAsync } from '../ui';
import { ProjectHeader } from './board';

function Install(props: { project: AppProject }) {
  const install = props.project.install!;
  const site = props.project.origins[0];
  const activation = site ? `${site}/?${ACTIVATION_PARAM}=${install.accessKey}` : null;
  return (
    <section class="card">
      <h2>Install the widget</h2>
      <p class="muted">
        <b>WordPress:</b> install the Annotate plugin and click Connect. <b>Any other site:</b> add this tag to every page, before <code>&lt;/body&gt;</code>.
      </p>
      <div class="copy-block">
        <pre>{install.snippet}</pre>
        <CopyButton text={install.snippet} />
      </div>
      <p class="muted">
        The widget stays hidden from visitors. Clients turn it on once with the activation link (it's remembered in their browser); logged-in WordPress editors always see it.
      </p>
      {activation ? (
        <div class="copy-block">
          <pre>{activation}</pre>
          <CopyButton text={activation} />
        </div>
      ) : null}
    </section>
  );
}

function General(props: { project: AppProject; onSaved: (p: AppProject) => void }) {
  const p = props.project;
  const [name, setName] = useState(p.name);
  const [origins, setOrigins] = useState(p.origins.join('\n'));
  const [ignoreQuery, setIgnoreQuery] = useState(p.ignoreQuery);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setName(p.name);
    setOrigins(p.origins.join('\n'));
    setIgnoreQuery(p.ignoreQuery);
  }, [p.id]);
  const save = async (e: Event) => {
    e.preventDefault();
    setError(null);
    try {
      const list = origins.split(/[\s,]+/).filter(Boolean).map((o) => (/^https?:\/\//.test(o) ? o : `https://${o}`));
      props.onSaved(await api<AppProject>(`/projects/${p.id}`, { method: 'PATCH', body: { name, origins: list, ignoreQuery } }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form class="card form" onSubmit={save}>
      <h2>Project</h2>
      <ErrorNote message={error} />
      <label class="field">
        <span>Name</span>
        <input type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} maxLength={100} required />
      </label>
      <label class="field">
        <span>Sites the widget may run on (one per line; staging and live)</span>
        <textarea rows={3} value={origins} onInput={(e) => setOrigins((e.target as HTMLTextAreaElement).value)} />
      </label>
      <label class="check">
        <input type="checkbox" checked={ignoreQuery} onChange={(e) => setIgnoreQuery((e.target as HTMLInputElement).checked)} /> Treat pages that differ only in their query string (?…) as the same page
      </label>
      <div class="row-actions">
        <button class="btn btn-primary" type="submit">
          Save
        </button>
        {saved ? <span class="muted small">Saved</span> : null}
      </div>
    </form>
  );
}

function AgentKeys(props: { project: AppProject }) {
  const { me } = useSession();
  const tokens = useAsync(() => api<AppAgentTokensResponse>(`/projects/${props.project.id}/tokens`), [props.project.id]);
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<AppNewAgentTokenResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canRevokeAll = props.project.role === 'owner' || props.project.role === 'admin';
  const create = async (e: Event) => {
    e.preventDefault();
    setError(null);
    try {
      setFresh(await api<AppNewAgentTokenResponse>(`/projects/${props.project.id}/tokens`, { body: { label } }));
      setLabel('');
      await tokens.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const revoke = async (id: string) => {
    if (!confirm('Revoke this key? Agents using it stop working.')) return;
    try {
      tokens.setData(() => null);
      await api(`/projects/${props.project.id}/tokens/${id}`, { method: 'DELETE' });
    } catch (err) {
      setError((err as Error).message);
    }
    await tokens.reload();
  };
  return (
    <section class="card">
      <h2>Agent keys</h2>
      <p class="muted">
        Coding agents use the <code>annotate</code> CLI to read, fix and resolve issues. Create a key, then save the file it gives you as <code>.annotate.json</code> in the site's repository (it's
        secret: keep it out of git).
      </p>
      <ErrorNote message={error ?? tokens.error} />
      {fresh ? (
        <div class="note">
          <p>
            <b>Save this as .annotate.json now.</b> The key isn't shown again.
          </p>
          <div class="copy-block">
            <pre>{fresh.config}</pre>
            <CopyButton text={fresh.config} />
          </div>
        </div>
      ) : null}
      <form class="inline-fields" onSubmit={create}>
        <input type="text" value={label} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} placeholder="Where it's used, e.g. QA server" maxLength={80} />
        <button class="btn btn-primary" type="submit">
          Create key
        </button>
      </form>
      {tokens.data ? (
        <div class="table">
          {tokens.data.tokens.map((t) => (
            <div class={`table-row${t.revokedAt ? ' revoked' : ''}`}>
              <div class="grow">
                <div>{t.label}</div>
                <div class="muted small">
                  {t.createdBy ? `by ${t.createdBy}` : 'from before accounts'} · created {timeAgo(t.createdAt)}
                  {t.lastUsedAt ? ` · last used ${timeAgo(t.lastUsedAt)}` : ' · never used'}
                  {t.revokedAt ? ` · revoked ${timeAgo(t.revokedAt)}` : ''}
                </div>
              </div>
              {!t.revokedAt && (canRevokeAll || t.createdBy === me.user.email) ? (
                <button type="button" class="btn btn-quiet btn-small" onClick={() => void revoke(t.id)}>
                  Revoke
                </button>
              ) : null}
            </div>
          ))}
          {tokens.data.tokens.length ? null : <p class="muted small">No keys yet.</p>}
        </div>
      ) : (
        <Loading />
      )}
    </section>
  );
}

function Trello(props: { project: AppProject }) {
  const t = props.project.trello;
  return (
    <section class="card">
      <h2>Trello</h2>
      {t ? (
        <>
          <p>
            Synced with{' '}
            <a href={t.boardUrl} target="_blank" rel="noopener">
              {t.boardName}
            </a>
            : moves and comments go both ways.
          </p>
          {t.revoked ? <p class="note note-warn">The Trello login behind the sync stopped working. Changes are kept here and sent once it's reconnected.</p> : null}
          {t.error && !t.revoked ? <p class="muted small">Last problem sending to Trello: {t.error}</p> : null}
        </>
      ) : (
        <p class="muted">Not synced. Issues live here in Annotate. Connecting a Trello board from the dashboard is coming.</p>
      )}
    </section>
  );
}

function Danger(props: { project: AppProject }) {
  const [error, setError] = useState<string | null>(null);
  const del = async () => {
    if (prompt(`This deletes ${props.project.name}, all its issues and screenshots. Type the project name to confirm.`) !== props.project.name) return;
    try {
      await api(`/projects/${props.project.id}`, { method: 'DELETE' });
      navigate(href.projects(props.project.orgId));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section class="card danger">
      <h2>Delete project</h2>
      <ErrorNote message={error} />
      <p class="muted">Removes every issue, comment and screenshot. The Trello board, if any, is left alone.</p>
      <button type="button" class="btn btn-danger" onClick={() => void del()}>
        Delete project…
      </button>
    </section>
  );
}

export function SettingsPage(props: { projectId: string }) {
  const { setOrg } = useSession();
  const project = useAsync(() => api<AppProject>(`/projects/${props.projectId}`), [props.projectId]);
  useEffect(() => {
    if (project.data) setOrg(project.data.orgId);
  }, [project.data?.orgId]);
  if (!project.data) return <main class="page">{project.error ? <ErrorNote message={project.error} /> : <Loading />}</main>;
  const p = project.data;
  if (p.role === 'client') {
    navigate(href.board(p.id), true);
    return null;
  }
  return (
    <main class="page settings">
      <ProjectHeader project={p} tab="settings" />
      <Install project={p} />
      <General project={p} onSaved={(np) => project.setData(() => np)} />
      <AgentKeys project={p} />
      <Trello project={p} />
      {p.role === 'owner' || p.role === 'admin' ? <Danger project={p} /> : null}
    </main>
  );
}
