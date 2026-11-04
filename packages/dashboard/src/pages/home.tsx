// /app/: straight to the last org's projects; an empty state (or "name your agency") for someone in no org.

import { useEffect, useState } from 'preact/hooks';
import type { AppOrg } from '@annotate/shared';
import { api } from '../api';
import { lastOrg, useSession } from '../app';
import { href, navigate } from '../router';
import { ErrorNote } from '../ui';

export function HomePage() {
  const { me, reloadMe } = useSession();
  const target = me.orgs.find((o) => o.id === lastOrg()) ?? me.orgs[0];
  useEffect(() => {
    if (target) navigate(href.projects(target.id), true);
  }, [target?.id]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (target) return null;

  const create = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      const org = await api<AppOrg>('/orgs', { body: { name } });
      await reloadMe();
      navigate(href.projects(org.id));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main class="page narrow">
      {me.canCreateOrg ? (
        <>
          <h1>Name your agency</h1>
          <p class="lead">Your projects and team live in it. You can rename it later.</p>
          <ErrorNote message={error} />
          <form class="stack" onSubmit={create}>
            <input type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Acme Web Studio" required maxLength={100} autoFocus />
            <button class="btn btn-primary" type="submit" disabled={busy || !name.trim()}>
              Create
            </button>
          </form>
        </>
      ) : (
        <>
          <h1>You're not in an organization yet</h1>
          <p class="lead">
            Annotate is invite-only for now. Ask your agency to add <b>{me.user.email}</b>, then log in again.
          </p>
        </>
      )}
    </main>
  );
}
