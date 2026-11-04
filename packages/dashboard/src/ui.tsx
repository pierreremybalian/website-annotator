// Small shared pieces: data loading, labels, copy buttons.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { IssueStatus } from '@annotate/shared';

export const STATUS_LABEL: Record<IssueStatus, string> = {
  new: 'New',
  in_progress: 'In progress',
  review: 'Ready for review',
  resolved: 'Resolved',
  archived: 'Archived',
};
export const BOARD_COLUMNS: IssueStatus[] = ['new', 'in_progress', 'review', 'resolved'];

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export interface Async<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (fn: (prev: T | null) => T | null) => void;
}

/** Load `fn()` now and whenever `deps` change. Keeps the last data while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const value = await fn();
      if (mine === seq.current) {
        setDataState(value);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    setDataState(null);
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData: (f) => setDataState(f) };
}

/** Run `fn` every `ms` while the tab is visible, and right away when it becomes visible again. */
export function usePoll(fn: () => void, ms: number) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    const tick = () => document.visibilityState === 'visible' && saved.current();
    const id = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [ms]);
}

export function CopyButton(props: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      class="btn btn-small"
      onClick={() =>
        navigator.clipboard.writeText(props.text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        })
      }
    >
      {done ? 'Copied' : (props.label ?? 'Copy')}
    </button>
  );
}

export const ErrorNote = (props: { message: string | null }) => (props.message ? <p class="note note-error">{props.message}</p> : null);

export const Loading = () => (
  <div class="loading" aria-live="polite">
    <span class="spinner" /> Loading…
  </div>
);
