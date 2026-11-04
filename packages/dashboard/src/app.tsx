// The dashboard shell: who's logged in, the top bar (org switcher, Projects / Team, log out) and the page for
// the current route.

import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { AppMe, AppOrg } from '@annotate/shared';
import { api, logout } from './api';
import { href, Link, navigate, useRoute } from './router';
import { ErrorNote, Loading, useAsync } from './ui';
import { HomePage } from './pages/home';
import { ProjectsPage } from './pages/projects';
import { TeamPage } from './pages/team';
import { BoardPage } from './pages/board';
import { SettingsPage } from './pages/settings';

interface Session {
  me: AppMe;
  reloadMe: () => Promise<void>;
  /** The org the page is about; pages showing a project set it from the project. */
  setOrg: (id: string | null) => void;
}
const SessionContext = createContext<Session | null>(null);
export const useSession = () => useContext(SessionContext)!;

const LAST_ORG = 'annotate:lastOrg';
export const rememberOrg = (id: string) => {
  try {
    localStorage.setItem(LAST_ORG, id);
  } catch {
    /* private mode */
  }
};
export const lastOrg = () => {
  try {
    return localStorage.getItem(LAST_ORG);
  } catch {
    return null;
  }
};

const BrandMark = () => (
  <svg width="24" height="24" viewBox="0 0 28 28" aria-hidden="true">
    <rect width="28" height="28" rx="8" fill="#ff4f2b" />
    <path d="M14 6.5a5.8 5.8 0 0 0-5.8 5.8c0 4.3 5.8 9.2 5.8 9.2s5.8-4.9 5.8-9.2A5.8 5.8 0 0 0 14 6.5z" fill="#fff" />
    <circle cx="14" cy="12.3" r="2.1" fill="#ff4f2b" />
  </svg>
);

function TopBar(props: { me: AppMe; org: AppOrg | null; section: 'projects' | 'team' | null }) {
  const { me, org } = props;
  return (
    <header class="topbar">
      <Link href="/app/" class="brand">
        <BrandMark />
        <span>Annotate</span>
      </Link>
      {me.orgs.length > 1 ? (
        <select class="org-switch" aria-label="Organization" value={org?.id ?? ''} onChange={(e) => navigate(href.projects((e.target as HTMLSelectElement).value))}>
          {org ? null : <option value="">Choose…</option>}
          {me.orgs.map((o) => (
            <option value={o.id}>{o.name}</option>
          ))}
        </select>
      ) : org ? (
        <span class="org-name">{org.name}</span>
      ) : null}
      {org ? (
        <nav class="tabs">
          <Link href={href.projects(org.id)} class={props.section === 'projects' ? 'on' : ''}>
            Projects
          </Link>
          {org.role !== 'client' ? (
            <Link href={href.team(org.id)} class={props.section === 'team' ? 'on' : ''}>
              Team
            </Link>
          ) : null}
        </nav>
      ) : null}
      <div class="spacer" />
      <span class="who" title={me.user.email}>
        {me.user.name || me.user.email}
      </span>
      <button type="button" class="btn btn-quiet btn-small" onClick={() => void logout()}>
        Log out
      </button>
    </header>
  );
}

export function App() {
  const route = useRoute();
  const me = useAsync(() => api<AppMe>('/me'), []);
  const [pageOrg, setOrg] = useState<string | null>(null);
  const routeOrg = route.page === 'projects' || route.page === 'team' ? route.org : null;
  const orgId = routeOrg ?? (route.page === 'board' || route.page === 'settings' ? pageOrg : null);
  useEffect(() => {
    if (orgId) rememberOrg(orgId);
  }, [orgId]);

  if (!me.data) return <main class="page">{me.error ? <ErrorNote message={me.error} /> : <Loading />}</main>;
  const org = me.data.orgs.find((o) => o.id === orgId) ?? null;
  const section = route.page === 'team' ? 'team' : route.page === 'home' || route.page === 'notFound' ? null : 'projects';

  return (
    <SessionContext.Provider value={{ me: me.data, reloadMe: me.reload, setOrg }}>
      <TopBar me={me.data} org={org} section={section} />
      {route.page === 'home' ? <HomePage /> : null}
      {route.page === 'projects' ? <ProjectsPage org={org} orgId={route.org} /> : null}
      {route.page === 'team' ? <TeamPage org={org} orgId={route.org} /> : null}
      {route.page === 'board' ? <BoardPage projectId={route.project} issueId={route.issue} /> : null}
      {route.page === 'settings' ? <SettingsPage projectId={route.project} /> : null}
      {route.page === 'notFound' ? (
        <main class="page">
          <h1>Page not found</h1>
          <p>
            <Link href="/app/">Back to your projects</Link>
          </p>
        </main>
      ) : null}
    </SessionContext.Provider>
  );
}
