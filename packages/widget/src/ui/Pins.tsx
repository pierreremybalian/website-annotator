// Pin layer: one numbered marker per existing issue on this page, plus the popover for the open one.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { IssueDetail, IssueSummary, Rect } from '@annotate/shared';
import type { PinsProps } from '../types';
import { matchAnchor, rectForAnchor } from '../capture/anchor';
import { PinPopover, POPOVER_CSS, STATUS_LABEL } from './PinPopover';

/** Pin diameter (px). */
const PIN = 26;
/** How far the pin's point reaches into the selection's top-left corner. */
const NUDGE = 5;

interface Placed {
  rect: Rect;
  detached: boolean;
}
interface Layout {
  vw: number;
  vh: number;
  pos: Record<string, Placed>;
}

const EMPTY_LAYOUT: Layout = { vw: 0, vh: 0, pos: {} };

function near(a: number, b: number) {
  return Math.abs(a - b) < 0.5;
}

function sameLayout(a: Layout, b: Layout): boolean {
  if (a.vw !== b.vw || a.vh !== b.vh) return false;
  const ak = Object.keys(a.pos);
  if (ak.length !== Object.keys(b.pos).length) return false;
  for (const k of ak) {
    const p = a.pos[k];
    const q = b.pos[k];
    if (!p || !q || p.detached !== q.detached) return false;
    if (!near(p.rect.x, q.rect.x) || !near(p.rect.y, q.rect.y)) return false;
    if (!near(p.rect.width, q.rect.width) || !near(p.rect.height, q.rect.height)) return false;
  }
  return true;
}

/** Pin sits up-left of the corner with its point on it; kept on-screen when the corner is. */
function pinPoint(rect: Rect, vw: number, vh: number) {
  let left = rect.x - PIN + NUDGE;
  let top = rect.y - PIN + NUDGE;
  if (rect.x >= 0 && rect.x <= vw) left = Math.min(Math.max(2, left), vw - PIN - 2);
  if (rect.y >= 0 && rect.y <= vh) top = Math.min(Math.max(2, top), vh - PIN - 2);
  return { left, top };
}

function offscreen(rect: Rect, vw: number, vh: number) {
  return rect.x + rect.width < -PIN || rect.y + rect.height < -PIN || rect.x > vw + PIN || rect.y > vh + PIN;
}

/** Mutations caused by the widget itself (its host being added, shown, hidden) don't move pins. */
function isOwnMutation(r: MutationRecord, host: Element | null): boolean {
  if (!host) return false;
  if (r.target === host || host.contains(r.target)) return true;
  if (r.type === 'childList') {
    const nodes = [...r.addedNodes, ...r.removedNodes];
    return nodes.length > 0 && nodes.every((n) => n === host);
  }
  return false;
}

export function Pins(props: PinsProps) {
  const { api, pageUrl, showResolved, refreshKey, openIssueId, reporter, onReporterChange } = props;

  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [layout, setLayout] = useState<Layout>(EMPTY_LAYOUT);
  const [openId, setOpenId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const layerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<Element | null>(null);
  const issuesRef = useRef<IssueSummary[]>([]);
  /** Matched element per issue id; refreshed only when the DOM may have changed, not on every scroll. */
  const elsRef = useRef(new Map<string, Element | null>());
  const dirtyRef = useRef(true);
  const rafRef = useRef(0);
  const warnedRef = useRef(false);
  const detailCache = useRef(new Map<string, IssueDetail>());
  const openedForRef = useRef<string | null>(null);

  // One stable recompute/schedule pair for all listeners.
  const engine = useRef<{ recompute(): void; schedule(rematch: boolean): void } | null>(null);
  if (!engine.current) {
    const recompute = () => {
      rafRef.current = 0;
      const list = issuesRef.current;
      if (dirtyRef.current) {
        const els = new Map<string, Element | null>();
        for (const i of list) {
          try {
            els.set(i.id, matchAnchor(i.anchor));
          } catch {
            els.set(i.id, null);
          }
        }
        elsRef.current = els;
        dirtyRef.current = false;
      }
      const pos: Record<string, Placed> = {};
      for (const i of list) {
        try {
          pos[i.id] = rectForAnchor(i.anchor, elsRef.current.get(i.id) ?? null);
        } catch {
          // Malformed anchor: no pin for this one.
        }
      }
      const next: Layout = { vw: window.innerWidth, vh: window.innerHeight, pos };
      setLayout((prev) => (sameLayout(prev, next) ? prev : next));
    };
    const schedule = (rematch: boolean) => {
      if (rematch) dirtyRef.current = true;
      if (!rafRef.current) rafRef.current = requestAnimationFrame(recompute);
    };
    engine.current = { recompute, schedule };
  }

  // Fetch the page's issues; ignore responses that arrive after a newer request started.
  useEffect(() => {
    let current = true;
    api.listIssues(pageUrl, showResolved).then(
      (list) => {
        if (current) setIssues(Array.isArray(list) ? list : []);
      },
      (err) => {
        if (!current || warnedRef.current) return;
        warnedRef.current = true;
        console.warn('[annotate] could not load pins', err);
      },
    );
    return () => {
      current = false;
    };
  }, [api, pageUrl, showResolved, refreshKey]);

  // Place pins synchronously when the list changes, so they don't flash at stale positions.
  useLayoutEffect(() => {
    issuesRef.current = issues;
    dirtyRef.current = true;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    engine.current!.recompute();
  }, [issues]);

  // Keep pins glued to the page.
  useEffect(() => {
    const { schedule } = engine.current!;
    const onMove = () => schedule(false);
    const onRematch = () => schedule(true);
    let alive = true;

    window.addEventListener('scroll', onMove, { capture: true, passive: true }); // capture: inner scrollers too
    window.addEventListener('resize', onMove, { passive: true });
    window.addEventListener('load', onRematch);
    document.addEventListener('load', onMove, true); // late images, iframes (load doesn't bubble)
    document.fonts?.ready.then(() => {
      if (alive) onRematch();
    });

    const mo = new MutationObserver((records) => {
      const host = hostRef.current;
      if (records.some((r) => !isOwnMutation(r, host))) onRematch();
    });
    mo.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });

    return () => {
      alive = false;
      window.removeEventListener('scroll', onMove, { capture: true });
      window.removeEventListener('resize', onMove);
      window.removeEventListener('load', onRematch);
      document.removeEventListener('load', onMove, true);
      mo.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, []);

  // Remember our shadow host (to ignore our own mutations) once the layer exists.
  useLayoutEffect(() => {
    const root = layerRef.current?.getRootNode();
    if (root instanceof ShadowRoot) hostRef.current = root.host;
  });

  // Open a requested issue once it shows up in the list.
  useEffect(() => {
    if (!openIssueId) {
      openedForRef.current = null;
      return;
    }
    if (openedForRef.current === openIssueId) return;
    if (issues.some((i) => i.id === openIssueId)) {
      openedForRef.current = openIssueId;
      setOpenId(openIssueId);
    }
  }, [openIssueId, issues]);

  // Drop popover/hover state for issues that left the list.
  useEffect(() => {
    if (openId && !issues.some((i) => i.id === openId)) setOpenId(null);
    if (hoverId && !issues.some((i) => i.id === hoverId)) setHoverId(null);
  }, [issues]);

  const onDetail = (d: IssueDetail) => {
    detailCache.current.set(d.id, d);
    // GET /v1/issues/:id refreshes status from Trello; reflect it on the pin.
    setIssues((list) =>
      list.some((i) => i.id === d.id && i.status !== d.status)
        ? list.map((i) => (i.id === d.id ? { ...i, status: d.status } : i))
        : list,
    );
  };

  if (issues.length === 0) return null;

  const { vw, vh, pos } = layout;
  const openIssue = openId ? issues.find((i) => i.id === openId) : undefined;
  const openPlaced = openIssue ? pos[openIssue.id] : undefined;
  const hlId = hoverId ?? openId;
  const hlIssue = hlId ? issues.find((i) => i.id === hlId) : undefined;
  const hlPlaced = hlIssue ? pos[hlIssue.id] : undefined;

  return (
    <div class="an-pins" ref={layerRef}>
      <style>{PINS_CSS + POPOVER_CSS}</style>

      {hlIssue && hlPlaced && !offscreen(hlPlaced.rect, vw, vh) && (
        <div
          class={`an-hl an-pin-st-${hlIssue.status}${hlPlaced.detached ? ' an-hl--detached' : ''}`}
          style={{
            left: `${hlPlaced.rect.x}px`,
            top: `${hlPlaced.rect.y}px`,
            width: `${hlPlaced.rect.width}px`,
            height: `${hlPlaced.rect.height}px`,
          }}
        />
      )}

      {issues.map((issue) => {
        const p = pos[issue.id];
        if (!p || offscreen(p.rect, vw, vh)) return null;
        const at = pinPoint(p.rect, vw, vh);
        const isOpen = issue.id === openId;
        const label = `Issue #${issue.number}: ${issue.title || 'Untitled'} (${STATUS_LABEL[issue.status] ?? issue.status})`;
        return (
          <button
            key={issue.id}
            type="button"
            data-an-pin={issue.id}
            class={
              `an-pin an-pin-st-${issue.status}` +
              (p.detached ? ' an-pin--detached' : '') +
              (isOpen ? ' an-pin--open' : '') +
              (issue.number >= 100 ? ' an-pin--wide' : '')
            }
            style={{ left: `${at.left}px`, top: `${at.top}px` }}
            aria-label={p.detached ? `${label}, position may have moved` : label}
            aria-expanded={isOpen ? 'true' : 'false'}
            title={issue.title || undefined}
            onClick={() => setOpenId((id) => (id === issue.id ? null : issue.id))}
            onMouseEnter={() => setHoverId(issue.id)}
            onMouseLeave={() => setHoverId((h) => (h === issue.id ? null : h))}
            onFocus={() => setHoverId(issue.id)}
            onBlur={() => setHoverId((h) => (h === issue.id ? null : h))}
          >
            {issue.number}
          </button>
        );
      })}

      {openIssue && openPlaced && (
        <PinPopover
          key={openIssue.id}
          issue={openIssue}
          detached={openPlaced.detached}
          pin={{ ...pinPoint(openPlaced.rect, vw, vh), size: PIN }}
          vw={vw}
          vh={vh}
          api={api}
          reporter={reporter}
          onReporterChange={onReporterChange}
          onClose={() => setOpenId(null)}
          cached={detailCache.current.get(openIssue.id)}
          onDetail={onDetail}
        />
      )}
    </div>
  );
}

const PINS_CSS = `
.an-pins {
  position: fixed; top: 0; left: 0; width: 0; height: 0;
  z-index: var(--an-z); pointer-events: none;
}
.an-pin-st-new { --an-c: var(--an-status-new); }
.an-pin-st-in_progress { --an-c: var(--an-status-in_progress); }
.an-pin-st-resolved { --an-c: var(--an-status-resolved); }
.an-pin-st-archived { --an-c: var(--an-status-archived); }
.an-pin {
  position: fixed; z-index: 1;
  width: ${PIN}px; height: ${PIN}px; margin: 0; padding: 0;
  display: grid; place-items: center;
  border: 2px solid #fff; border-radius: 50% 50% 3px 50%;
  background: var(--an-c); color: #fff;
  font: 700 12px/1 var(--an-font); font-variant-numeric: tabular-nums; letter-spacing: -.02em;
  box-shadow: 0 2px 6px rgba(0,0,0,.28), 0 0 0 1px rgba(0,0,0,.08);
  cursor: pointer; pointer-events: auto;
  transform-origin: 100% 100%;
  transition: transform .12s ease;
}
.an-pin--wide { font-size: 10px; }
.an-pin:hover, .an-pin--open { transform: scale(1.12); }
.an-pin--open { z-index: 2; }
.an-pin:focus { outline: none; }
.an-pin:focus-visible { box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--an-ink); }
.an-pin--detached { outline: 2px dashed var(--an-c); outline-offset: 2px; }
.an-pin--detached:focus-visible { outline: 2px dashed var(--an-c); }
.an-hl {
  position: fixed; pointer-events: none;
  border: 2px solid var(--an-c); border-radius: 4px;
  background: color-mix(in srgb, var(--an-c) 10%, transparent);
  box-shadow: 0 0 0 1px rgba(255,255,255,.7);
}
.an-hl--detached { border-style: dashed; }
@media (prefers-reduced-motion: reduce) { .an-pin { transition: none; } }
`;
