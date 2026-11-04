// A tiny History API router: the dashboard's few pages, matched by pattern, links that don't reload the page.

import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

const BASE = '/app';

export type Route =
  | { page: 'home' }
  | { page: 'projects'; org: string }
  | { page: 'team'; org: string }
  | { page: 'board'; project: string; issue: string | null }
  | { page: 'settings'; project: string }
  | { page: 'notFound' };

export function parse(pathname: string, search = ''): Route {
  const path = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const [a, b, c] = parts;
  if (!a) return { page: 'home' };
  if (a === 'o' && b && !c) return { page: 'projects', org: b };
  if (a === 'o' && b && c === 'team') return { page: 'team', org: b };
  if (a === 'p' && b && !c) return { page: 'board', project: b, issue: new URLSearchParams(search).get('issue') };
  if (a === 'p' && b && c === 'settings') return { page: 'settings', project: b };
  return { page: 'notFound' };
}

export const href = {
  projects: (org: string) => `${BASE}/o/${encodeURIComponent(org)}`,
  team: (org: string) => `${BASE}/o/${encodeURIComponent(org)}/team`,
  board: (project: string, issue?: string | null) => `${BASE}/p/${encodeURIComponent(project)}${issue ? `?issue=${encodeURIComponent(issue)}` : ''}`,
  settings: (project: string) => `${BASE}/p/${encodeURIComponent(project)}/settings`,
};

const listeners = new Set<() => void>();

export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', to);
  listeners.forEach((l) => l());
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.pathname, location.search));
  useEffect(() => {
    const update = () => setRoute(parse(location.pathname, location.search));
    listeners.add(update);
    addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      removeEventListener('popstate', update);
    };
  }, []);
  return route;
}

export function Link(props: { href: string; class?: string; children?: ComponentChildren; title?: string }) {
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(props.href);
  };
  return (
    <a href={props.href} class={props.class} title={props.title} onClick={onClick}>
      {props.children}
    </a>
  );
}
