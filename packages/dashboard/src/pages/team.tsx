// /app/o/:org/team: members and their roles, invitations. Admins and owners manage; members can look.

import { useState } from 'preact/hooks';
import type { AppMember, AppMembersResponse, AppOrg, AppProjectsResponse, Role } from '@annotate/shared';
import { api } from '../api';
import { useSession } from '../app';
import { ErrorNote, Loading, timeAgo, useAsync } from '../ui';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including owners and the organization itself',
  admin: 'Manages projects and people',
  member: 'Works on every project: board, settings, agent keys',
  client: 'Sees only the projects picked for them; comments, confirms fixes, reopens',
};
const ROLES: Role[] = ['client', 'member', 'admin', 'owner'];

function ProjectPicker(props: { projects: AppProjectsResponse['projects']; value: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div class="checks">
      {props.projects.map((p) => (
        <label class="check">
          <input
            type="checkbox"
            checked={props.value.includes(p.id)}
            onChange={(e) => props.onChange((e.target as HTMLInputElement).checked ? [...props.value, p.id] : props.value.filter((id) => id !== p.id))}
          />
          {p.name}
        </label>
      ))}
    </div>
  );
}

function Invite(props: { org: AppOrg; projects: AppProjectsResponse['projects']; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ member: AppMember; emailed: boolean }>(`/orgs/${props.org.id}/members`, { body: { email, role, projectIds: role === 'client' ? projectIds : undefined } });
      setSent(r.emailed ? `Invitation sent to ${r.member.email}.` : `${r.member.email} is added, but the email didn't go out. They can log in with their address at ${location.origin}/login.`);
      setEmail('');
      setProjectIds([]);
      props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="card form" onSubmit={submit}>
      <h2>Invite someone</h2>
      <ErrorNote message={error} />
      {sent ? <p class="note">{sent}</p> : null}
      <div class="inline-fields">
        <label class="field grow">
          <span>Email</span>
          <input type="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} placeholder="name@company.com" required />
        </label>
        <label class="field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value as Role)}>
            {ROLES.filter((r) => r !== 'owner' || props.org.role === 'owner').map((r) => (
              <option value={r}>{r[0]!.toUpperCase() + r.slice(1)}</option>
            ))}
          </select>
        </label>
      </div>
      <p class="muted small">{ROLE_HELP[role]}</p>
      {role === 'client' ? (
        props.projects.length ? (
          <ProjectPicker projects={props.projects} value={projectIds} onChange={setProjectIds} />
        ) : (
          <p class="muted small">Create a project first, then invite its client.</p>
        )
      ) : null}
      <div class="row-actions">
        <button class="btn btn-primary" type="submit" disabled={busy || !email.trim() || (role === 'client' && !projectIds.length)}>
          Send invitation
        </button>
      </div>
    </form>
  );
}

export function TeamPage(props: { org: AppOrg | null; orgId: string }) {
  const { me } = useSession();
  const members = useAsync(() => api<AppMembersResponse>(`/orgs/${props.orgId}/members`), [props.orgId]);
  const projects = useAsync(() => api<AppProjectsResponse>(`/orgs/${props.orgId}/projects`), [props.orgId]);
  const [error, setError] = useState<string | null>(null);
  if (!props.org) return <main class="page">{members.error ? <ErrorNote message={members.error} /> : <Loading />}</main>;
  const org = props.org;
  const canManage = org.role === 'owner' || org.role === 'admin';
  const projectName = (id: string) => projects.data?.projects.find((p) => p.id === id)?.name ?? 'a project';

  const update = async (m: AppMember, role: Role) => {
    setError(null);
    try {
      await api(`/orgs/${org.id}/members/${m.userId}`, { method: 'PATCH', body: { role, ...(role === 'client' ? { projectIds: m.projectIds } : {}) } });
    } catch (err) {
      setError((err as Error).message);
    }
    await members.reload();
  };
  const remove = async (m: AppMember) => {
    if (!confirm(m.userId === me.user.id ? `Leave ${org.name}?` : `Remove ${m.email} from ${org.name}? Their agent keys stop working.`)) return;
    setError(null);
    try {
      await api(`/orgs/${org.id}/members/${m.userId}`, { method: 'DELETE' });
      if (m.userId === me.user.id) location.assign('/app/');
    } catch (err) {
      setError((err as Error).message);
    }
    await members.reload();
  };

  return (
    <main class="page">
      <div class="page-head">
        <h1>Team</h1>
      </div>
      <ErrorNote message={error ?? members.error} />
      {members.data ? (
        <div class="card table">
          {members.data.members.map((m) => (
            <div class="table-row">
              <div class="grow">
                <div>
                  {m.name || m.email} {m.userId === me.user.id ? <span class="muted">(you)</span> : null}
                </div>
                <div class="muted small">
                  {m.name ? `${m.email} · ` : ''}
                  {m.verified ? `joined ${timeAgo(m.createdAt)}` : 'invited, hasn’t logged in yet'}
                  {m.role === 'client' && m.projectIds.length ? ` · sees ${m.projectIds.map(projectName).join(', ')}` : ''}
                </div>
              </div>
              {canManage && (m.role !== 'owner' || org.role === 'owner') ? (
                <select aria-label={`Role of ${m.email}`} value={m.role} onChange={(e) => void update(m, (e.target as HTMLSelectElement).value as Role)}>
                  {ROLES.filter((r) => r !== 'owner' || org.role === 'owner').map((r) => (
                    <option value={r}>{r[0]!.toUpperCase() + r.slice(1)}</option>
                  ))}
                </select>
              ) : (
                <span class="pill">{m.role}</span>
              )}
              {(canManage && (m.role !== 'owner' || org.role === 'owner')) || m.userId === me.user.id ? (
                <button type="button" class="btn btn-quiet btn-small" onClick={() => void remove(m)}>
                  {m.userId === me.user.id ? 'Leave' : 'Remove'}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <Loading />
      )}
      {canManage ? <Invite org={org} projects={projects.data?.projects ?? []} onDone={() => void members.reload()} /> : null}
    </main>
  );
}
