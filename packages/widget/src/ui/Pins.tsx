// Pin layer: one numbered marker per issue on this page, the "Issues on this page" panel, and the
// popover for the open issue. Owns the issue list; the panel and popover only render it.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Anchor, IssueDetail, IssueSummary, Rect } from '@annotate/shared';
import type { PinsProps } from '../types';
import { matchAnchor, rectForAnchor } from '../capture/anchor';
import { PinPopover, POPOVER_CSS, STATUS_LABEL, type PopoverAnchor } from './PinPopover';
import { IssuePanel, PANEL_CSS, PANEL_NARROW, PANEL_WIDTH, SHEET_HEIGHT } from './IssuePanel';

/** Pin diameter (px). */
const PIN = 26;
/** Area mode: how far the pin's point reaches into the selection's top-left corner. */
const NUDGE = 5;
/** Element mode: how far inside the element's top-left corner the pin sits. */
const INSET = 4;
/** Minimum distance from the viewport edge for a pin whose target is on screen. */
const EDGE = 2;
/** How long a just-confirmed issue stays (popover says "Thanks!") before leaving a list that hides resolved ones. */
const THANKS_MS = 1600;
/** Panel click that scrolls the page: open the popover once scrolling pauses this long... */
const SCROLL_IDLE_MS = 140;
/** ...or after this long at most. */
const SCROLL_MAX_MS = 1500;

interface Placed {
  /** Viewport rect: the element's live box (element mode) or the selection (area mode). */
  rect: Rect;
  element: boolean;
  /** The element couldn't be found (or its text changed): rect is where it was reported. */
  detached: boolean;
  /** The element exists but isn't visible at this screen size: no pin, listed in the panel. */
  hidden: boolean;
}
interface Layout {
  vw: number;
  vh: number;
  pos: Record<string, Placed>;
}
interface OpenState {
  id: string;
  via: 'pin' | 'panel';
  /** Viewport top of the panel row that opened it (popovers anchored to the panel line up with it). */
  rowTop: number;
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
    if (!p || !q || p.detached !== q.detached || p.hidden !== q.hidden || p.element !== q.element) return false;
    if (!near(p.rect.x, q.rect.x) || !near(p.rect.y, q.rect.y)) return false;
    if (!near(p.rect.width, q.rect.width) || !near(p.rect.height, q.rect.height)) return false;
  }
  return true;
}

/**
 * Where an issue is right now, given its matched element (null → detached, at the reported position).
 * rectForAnchor gives element-mode anchors the element's live rect and flags hidden elements.
 */
function placeAnchor(anchor: Anchor, matched: Element | null): Placed {
  const { rect, detached, hidden } = rectForAnchor(anchor, matched);
  return { rect, detached, hidden: !!hidden, element: anchor.mode === 'element' };
}

/**
 * Element mode: just inside the top-left corner of the element's visible part, so a tall element keeps
 * its pin on screen. Area mode: up-left of the selection's corner with its point on it, kept on-screen
 * when the corner is.
 */
function pinPoint(p: Placed, vw: number, vh: number) {
  const { rect } = p;
  if (p.element) {
    const maxLeft = Math.max(rect.x + INSET, rect.x + rect.width - PIN - INSET);
    const maxTop = Math.max(rect.y + INSET, rect.y + rect.height - PIN - INSET);
    return {
      left: Math.min(Math.max(rect.x + INSET, EDGE), maxLeft, vw - PIN - EDGE),
      top: Math.min(Math.max(rect.y + INSET, EDGE), maxTop, vh - PIN - EDGE),
    };
  }
  let left = rect.x - PIN + NUDGE;
  let top = rect.y - PIN + NUDGE;
  if (rect.x >= 0 && rect.x <= vw) left = Math.min(Math.max(EDGE, left), vw - PIN - EDGE);
  if (rect.y >= 0 && rect.y <= vh) top = Math.min(Math.max(EDGE, top), vh - PIN - EDGE);
  return { left, top };
}

function offscreen(p: Placed, vw: number, vh: number) {
  const r = p.rect;
  if (p.element) return r.x + r.width <= 0 || r.y + r.height <= 0 || r.x >= vw || r.y >= vh;
  return r.x + r.width < -PIN || r.y + r.height < -PIN || r.x > vw + PIN || r.y > vh + PIN;
}

/** The issue's top-left corner is comfortably inside the visible area (no need to scroll to it). */
function inView(p: Placed, w: number, h: number) {
  const r = p.rect;
  return r.y >= 0 && r.y <= h - PIN * 2 && r.x + Math.min(r.width, PIN) > 0 && r.x <= w - PIN;
}

/** The panel's top-left corner: measured, else what the CSS will make it. */
function panelBox(el: HTMLElement | null, vw: number, vh: number): { left: number; top: number } {
  const r = el?.getBoundingClientRect();
  if (r && r.width > 0 && r.height > 0) return { left: r.left, top: r.top };
  return vw <= PANEL_NARROW
    ? { left: 0, top: Math.round(vh * (1 - SHEET_HEIGHT)) }
    : { left: Math.max(0, vw - PANEL_WIDTH), top: 0 };
}

function scrollBehavior(): ScrollBehavior {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  } catch {
    return 'smooth';
  }
}

/**
 * Bring an issue into view. Element mode scrolls the element itself (block center), which also handles
 * inner scrollers. With a bottom sheet covering part of the screen, or in area mode, the window scrolls
 * so the issue is centered in the visible area above the sheet.
 */
function revealOnPage(p: Placed, el: Element | null, areaH: number) {
  const behavior = scrollBehavior();
  if (p.element && el && areaH >= window.innerHeight - 1 && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ behavior, block: 'center', inline: 'nearest' });
    return;
  }
  const h = Math.min(p.rect.height, areaH);
  window.scrollTo({ left: window.scrollX, top: window.scrollY + p.rect.y + h / 2 - areaH / 2, behavior });
}

/** Calls done() once scrolling settles (scrollend, a pause, or a time limit). Returns a cancel function. */
function afterScroll(done: () => void): () => void {
  let idle = setTimeout(finish, SCROLL_IDLE_MS * 2); // nothing may scroll at all
  const max = setTimeout(finish, SCROLL_MAX_MS);
  function onScroll() {
    clearTimeout(idle);
    idle = setTimeout(finish, SCROLL_IDLE_MS);
  }
  function cancel() {
    clearTimeout(idle);
    clearTimeout(max);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('scrollend', finish, true);
  }
  function finish() {
    cancel();
    done();
  }
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('scrollend', finish, true);
  return cancel;
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
  const { api, pageUrl, showResolved, refreshKey, openIssueId, reporter, onReporterChange, showPins, panelOpen } = props;

  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retryKey, setRetryKey] = useState(0);
  const [layout, setLayout] = useState<Layout>(EMPTY_LAYOUT);
  const [open, setOpen] = useState<OpenState | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** Issue being scrolled to from the panel: outlined until its popover opens. */
  const [revealId, setRevealId] = useState<string | null>(null);

  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<Element | null>(null);
  const issuesRef = useRef<IssueSummary[]>([]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const showResolvedRef = useRef(showResolved);
  showResolvedRef.current = showResolved;
  const onPanelOpenChangeRef = useRef(props.onPanelOpenChange);
  onPanelOpenChangeRef.current = props.onPanelOpenChange;
  /** Matched element per issue id; refreshed only when the DOM may have changed, not on every scroll. */
  const elsRef = useRef(new Map<string, Element | null>());
  const dirtyRef = useRef(true);
  const rafRef = useRef(0);
  const warnedRef = useRef(false);
  const detailCache = useRef(new Map<string, IssueDetail>());
  const openedForRef = useRef<string | null>(null);
  const urlRef = useRef(pageUrl);
  const cancelRevealRef = useRef<(() => void) | null>(null);
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());

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
          pos[i.id] = placeAnchor(i.anchor, elsRef.current.get(i.id) ?? null);
        } catch {
          // Malformed anchor: no pin for this one (the panel still lists it).
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

  // Fetch the page's issues while pins or the panel need them; ignore responses that arrive after a
  // newer request started. The panel reuses this list.
  const active = showPins || panelOpen;
  useEffect(() => {
    if (!active) return;
    if (urlRef.current !== pageUrl) {
      urlRef.current = pageUrl;
      setIssues([]); // don't show the previous page's issues while this one loads
    }
    let current = true;
    setLoadState('loading');
    api.listIssues(pageUrl, showResolved).then(
      (list) => {
        if (!current) return;
        setIssues(Array.isArray(list) ? list : []);
        setLoadState('ready');
      },
      (err) => {
        if (!current) return;
        setLoadState('error');
        if (warnedRef.current) return;
        warnedRef.current = true;
        console.warn('[annotate] could not load pins', err);
      },
    );
    return () => {
      current = false;
    };
  }, [api, pageUrl, showResolved, refreshKey, active, retryKey]);

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

    const timers = timersRef.current;
    return () => {
      alive = false;
      window.removeEventListener('scroll', onMove, { capture: true });
      window.removeEventListener('resize', onMove);
      window.removeEventListener('load', onRematch);
      document.removeEventListener('load', onMove, true);
      mo.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      cancelRevealRef.current?.();
      for (const t of timers) clearTimeout(t);
      timers.clear();
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
      setOpen({ id: openIssueId, via: 'pin', rowTop: 0 });
    }
  }, [openIssueId, issues]);

  // Drop popover/hover state for issues that left the list.
  useEffect(() => {
    const has = (id: string | null) => !id || issues.some((i) => i.id === id);
    if (!has(open?.id ?? null)) setOpen(null);
    if (!has(hoverId)) setHoverId(null);
    if (!has(revealId)) {
      cancelRevealRef.current?.();
      setRevealId(null);
    }
  }, [issues]);

  // Row hover can't end with a mouseleave once the panel is gone. (A scroll-then-open still finishes:
  // on narrow screens the sheet closes itself to make room for it.)
  useEffect(() => {
    if (!panelOpen) setHoverId(null);
  }, [panelOpen]);

  const onDetail = (d: IssueDetail) => {
    detailCache.current.set(d.id, d);
    // GET /v1/issues/:id refreshes status from Trello; reflect it on the pin.
    setIssues((list) =>
      list.some((i) => i.id === d.id && i.status !== d.status)
        ? list.map((i) => (i.id === d.id ? { ...i, status: d.status } : i))
        : list,
    );
  };

  // Confirm/reopen: update in place; a confirmed issue leaves a list without resolved ones after "Thanks!".
  const onUpdated = (s: IssueSummary) => {
    setIssues((list) => list.map((i) => (i.id === s.id ? { ...i, ...s } : i)));
    const d = detailCache.current.get(s.id);
    if (d) detailCache.current.set(s.id, { ...d, ...s });
    if (!showResolvedRef.current && (s.status === 'resolved' || s.status === 'archived')) {
      const t = setTimeout(() => {
        timersRef.current.delete(t);
        setIssues((list) => list.filter((i) => i.id !== s.id));
      }, THANKS_MS);
      timersRef.current.add(t);
    }
  };

  const selectFromPanel = (issue: IssueSummary, row: HTMLElement) => {
    cancelRevealRef.current?.();
    cancelRevealRef.current = null;
    const rowTop = row.getBoundingClientRect().top;
    const show = () => {
      cancelRevealRef.current = null;
      setRevealId(null);
      setOpen({ id: issue.id, via: 'panel', rowTop });
    };
    const { vw, vh, pos } = layoutRef.current;
    const p = pos[issue.id];
    if (!p || p.hidden || p.detached) {
      show();
      return;
    }
    const box = panelBox(panelRef.current, vw, vh);
    let areaW = box.left;
    let areaH = vh;
    if (box.top > 0) {
      // Bottom sheet (narrow screens): no room for a pin popover above it, so it gets out of the way.
      if (showPins) onPanelOpenChangeRef.current(false);
      areaW = vw;
      areaH = showPins ? vh : box.top;
    }
    if (inView(p, areaW, areaH)) {
      show();
      return;
    }
    setOpen(null);
    setRevealId(issue.id);
    revealOnPage(p, elsRef.current.get(issue.id) ?? null, areaH);
    cancelRevealRef.current = afterScroll(show);
  };

  const { vw, vh, pos } = layout;
  const openIssue = open ? issues.find((i) => i.id === open.id) : undefined;

  if (!panelOpen && !openIssue && (!showPins || issues.length === 0)) return null;

  const openPlaced = openIssue ? pos[openIssue.id] : undefined;
  const box = panelOpen ? panelBox(panelRef.current, vw, vh) : null;
  const sheet = !!box && box.top > 0;

  // Beside its pin when one is drawn (and, for panel clicks, trustworthy); else next to the panel.
  let popAnchor: PopoverAnchor | null = null;
  let popVw = vw;
  let popVh = vh;
  if (open && openIssue) {
    const pinDrawn = !!openPlaced && showPins && !openPlaced.hidden;
    if (pinDrawn && !(open.via === 'panel' && openPlaced.detached)) {
      popAnchor = { kind: 'pin', ...pinPoint(openPlaced, vw, vh), size: PIN };
      // Keep clear of the panel.
      if (box && sheet) popVh = box.top;
      else if (box) popVw = box.left;
    } else if (box) {
      popAnchor = sheet ? { kind: 'edge', x: 0, top: 0 } : { kind: 'edge', x: box.left, top: open.rowTop };
    } else {
      popAnchor = { kind: 'edge', x: vw, top: 0 };
    }
  }

  const hlId = hoverId ?? revealId ?? open?.id ?? null;
  const hlIssue = hlId ? issues.find((i) => i.id === hlId) : undefined;
  const hlPlaced = hlIssue ? pos[hlIssue.id] : undefined;
  const hotId = hoverId ?? revealId;

  return (
    <div class="an-pins" ref={layerRef}>
      {hlIssue && hlPlaced && !hlPlaced.hidden && !offscreen(hlPlaced, vw, vh) && (
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

      {showPins &&
        issues.map((issue) => {
          const p = pos[issue.id];
          if (!p || p.hidden || offscreen(p, vw, vh)) return null;
          const at = pinPoint(p, vw, vh);
          const isOpen = issue.id === open?.id;
          const label = `Issue #${issue.number}: ${issue.title || 'Untitled'} (${STATUS_LABEL[issue.status] ?? issue.status})`;
          return (
            <button
              key={issue.id}
              type="button"
              data-an-pin={issue.id}
              class={
                `an-pin an-pin-st-${issue.status}` +
                (p.element ? ' an-pin--el' : '') +
                (p.detached ? ' an-pin--detached' : '') +
                (isOpen ? ' an-pin--open' : '') +
                (issue.id === hotId ? ' an-pin--hot' : '') +
                (issue.number >= 100 ? ' an-pin--wide' : '')
              }
              style={{ left: `${at.left}px`, top: `${at.top}px` }}
              aria-label={p.detached ? `${label}, position may have moved` : label}
              aria-expanded={isOpen ? 'true' : 'false'}
              title={issue.title || undefined}
              onClick={() => setOpen((o) => (o?.id === issue.id ? null : { id: issue.id, via: 'pin', rowTop: 0 }))}
              onMouseEnter={() => setHoverId(issue.id)}
              onMouseLeave={() => setHoverId((h) => (h === issue.id ? null : h))}
              onFocus={() => setHoverId(issue.id)}
              onBlur={() => setHoverId((h) => (h === issue.id ? null : h))}
            >
              {issue.number}
            </button>
          );
        })}

      {panelOpen && (
        <IssuePanel
          issues={issues}
          placement={pos}
          state={loadState}
          showResolved={showResolved}
          openId={open?.id ?? null}
          popoverOpen={!!(openIssue && popAnchor)}
          panelRef={panelRef}
          onSelect={selectFromPanel}
          onHover={setHoverId}
          onRetry={() => setRetryKey((k) => k + 1)}
          onClose={() => onPanelOpenChangeRef.current(false)}
        />
      )}

      {openIssue && popAnchor && (
        <PinPopover
          key={openIssue.id}
          issue={openIssue}
          detached={openPlaced ? openPlaced.detached : true}
          hidden={!!openPlaced?.hidden}
          anchor={popAnchor}
          vw={popVw}
          vh={popVh}
          api={api}
          reporter={reporter}
          onReporterChange={onReporterChange}
          onClose={() => setOpen(null)}
          cached={detailCache.current.get(openIssue.id)}
          onDetail={onDetail}
          onUpdated={onUpdated}
        />
      )}
    </div>
  );
}

/** Pin layer, popover and panel styles. Adopted into the shadow root once by index.ts. */
export const PIN_LAYER_CSS = (): string => PINS_CSS + POPOVER_CSS + PANEL_CSS;

const PINS_CSS = `
.an-pins {
  position: fixed; top: 0; left: 0; width: 0; height: 0;
  z-index: var(--an-z); pointer-events: none;
}
.an-pin-st-new { --an-c: var(--an-status-new); }
.an-pin-st-in_progress { --an-c: var(--an-status-in_progress); }
.an-pin-st-review { --an-c: var(--an-status-review); }
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
/* Element mode: the pin sits inside the element, its point on the element's top-left corner. */
.an-pin--el { border-radius: 3px 50% 50% 50%; transform-origin: 0 0; }
.an-pin--wide { font-size: 10px; }
.an-pin:hover, .an-pin--open, .an-pin--hot { transform: scale(1.12); }
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
