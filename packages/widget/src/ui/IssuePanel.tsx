// "Issues on this page": a drawer (bottom sheet on narrow screens) listing the issues Pins fetched,
// including the ones whose pin can't be drawn. Only used by Pins.tsx, which owns the data and the popover.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Ref } from 'preact';
import type { IssueSummary } from '@annotate/shared';
import { STATUS_LABEL, timeAgo } from './PinPopover';

/** Drawer width (px). */
export const PANEL_WIDTH = 360;
/** At or below this viewport width the panel is a bottom sheet. */
export const PANEL_NARROW = 640;
/** Bottom sheet height, as a fraction of the viewport. */
export const SHEET_HEIGHT = 0.62;

export interface PanelPlacement {
  hidden: boolean;
  detached: boolean;
}

export interface IssuePanelProps {
  issues: IssueSummary[];
  /** Where each issue currently is; missing = couldn't be placed (treated like detached). */
  placement: Record<string, PanelPlacement | undefined>;
  state: 'loading' | 'ready' | 'error';
  showResolved: boolean;
  openId: string | null;
  /** A popover is open: Esc closes that first. */
  popoverOpen: boolean;
  panelRef: Ref<HTMLDivElement>;
  onSelect(issue: IssueSummary, row: HTMLElement): void;
  onHover(id: string | null): void;
  onRetry(): void;
  onClose(): void;
}

export function IssuePanel(props: IssuePanelProps) {
  const { issues, placement, state, showResolved, openId, panelRef, onSelect, onHover, onRetry, onClose } = props;

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const popoverOpenRef = useRef(props.popoverOpen);
  popoverOpenRef.current = props.popoverOpen;
  const ownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !popoverOpenRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  // Move focus into the panel when it opens, so keyboard users land in the list.
  useEffect(() => {
    try {
      ownRef.current?.focus({ preventScroll: true });
    } catch {
      /* old browsers without FocusOptions */
    }
  }, []);

  const setRefs = (el: HTMLDivElement | null) => {
    ownRef.current = el;
    if (typeof panelRef === 'function') panelRef(el);
    else if (panelRef) panelRef.current = el;
  };

  const empty = showResolved ? 'No issues on this page' : 'No open issues on this page';
  const counted = state !== 'loading' || issues.length > 0;

  return (
    <div
      ref={setRefs}
      class="an-panel-drawer"
      role="dialog"
      aria-modal="false"
      aria-labelledby="an-panel-heading"
      tabIndex={-1}
    >
      <div class="an-panel-head">
        <h2 id="an-panel-heading" class="an-panel-heading">
          Issues on this page
        </h2>
        {counted && (
          <span class="an-panel-count" aria-label={`${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`}>
            {issues.length}
          </span>
        )}
        <button type="button" class="an-panel-close" aria-label="Close issues panel" onClick={() => onClose()}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <div class="an-panel-body">
        {state === 'error' && (
          <div class={`an-panel-error${issues.length ? '' : ' an-panel-error--full'}`} role="alert">
            {issues.length ? "Couldn't refresh the list." : "Couldn't load this page's issues."}{' '}
            <button type="button" class="an-panel-link" onClick={() => onRetry()}>
              Retry
            </button>
          </div>
        )}

        {state === 'loading' && issues.length === 0 && (
          <div class="an-panel-state">
            <span class="an-panel-spinner" aria-hidden="true" /> Loading issues…
          </div>
        )}

        {state === 'ready' && issues.length === 0 && (
          <div class="an-panel-empty">
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6" />
              <path d="M8 12.5l2.6 2.5L16 9.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <div class="an-panel-empty-title">{empty}</div>
          </div>
        )}

        {issues.length > 0 && (
          <ul class="an-panel-list">
            {issues.map((issue) => (
              <Row
                key={issue.id}
                issue={issue}
                placed={placement[issue.id]}
                open={issue.id === openId}
                onSelect={onSelect}
                onHover={onHover}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Row(props: {
  issue: IssueSummary;
  placed: PanelPlacement | undefined;
  open: boolean;
  onSelect: IssuePanelProps['onSelect'];
  onHover: IssuePanelProps['onHover'];
}) {
  const { issue, placed, open, onSelect, onHover } = props;
  const [thumbError, setThumbError] = useState(false);
  const hidden = !!placed?.hidden;
  const moved = !hidden && (!placed || placed.detached);
  const leave = () => onHover(null);

  return (
    <li>
      <button
        type="button"
        class={`an-panel-row${open ? ' an-panel-row--open' : ''}${hidden ? ' an-panel-row--hidden' : ''}`}
        data-an-row={issue.id}
        aria-current={open ? 'true' : undefined}
        onClick={(e) => onSelect(issue, e.currentTarget)}
        onMouseEnter={() => onHover(issue.id)}
        onMouseLeave={leave}
        onFocus={() => onHover(issue.id)}
        onBlur={leave}
      >
        <span class="an-panel-thumb" aria-hidden="true">
          {issue.screenshotUrl && !thumbError ? (
            <img src={issue.screenshotUrl} alt="" loading="lazy" onError={() => setThumbError(true)} />
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16">
              <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6" />
              <path d="M3 16l5-5 4 4 3-3 6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
            </svg>
          )}
        </span>
        <span class="an-panel-main">
          <span class="an-panel-title">
            <span class="an-panel-num">#{issue.number}</span> {issue.title || 'Untitled'}
          </span>
          <span class="an-panel-meta">
            <span class={`an-panel-badge an-pin-st-${issue.status}`}>
              <i class="an-panel-dot" />
              {STATUS_LABEL[issue.status] ?? issue.status}
            </span>
            <span class="an-panel-who">
              {issue.reporterName || 'Someone'}
              {issue.createdAt && (
                <>
                  {' · '}
                  <time dateTime={issue.createdAt}>{timeAgo(issue.createdAt)}</time>
                </>
              )}
            </span>
          </span>
          {hidden && (
            <span class="an-panel-flag">
              Not visible at this screen size, reported at {issue.anchor.viewportWidth}px
            </span>
          )}
          {moved && <span class="an-panel-flag an-panel-flag--moved">Position may have moved</span>}
        </span>
      </button>
    </li>
  );
}

export const PANEL_CSS = `
.an-panel-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 2;
  width: ${PANEL_WIDTH}px; max-width: 100vw;
  display: flex; flex-direction: column;
  background: var(--an-surface); color: var(--an-ink);
  border-left: 1px solid var(--an-border);
  box-shadow: -12px 0 32px rgba(0,0,0,.14), -1px 0 4px rgba(0,0,0,.06);
  pointer-events: auto; outline: none;
  font: 14px/1.4 var(--an-font); text-align: left;
}
.an-panel-drawer button { font: inherit; color: inherit; }
.an-panel-head {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 14px 12px 12px 16px; border-bottom: 1px solid var(--an-border);
}
.an-panel-heading { margin: 0; font-size: 15px; font-weight: 650; line-height: 1.3; }
.an-panel-count {
  min-width: 22px; height: 20px; padding: 0 7px; border-radius: 999px;
  display: inline-grid; place-items: center;
  background: var(--an-surface-2); color: var(--an-ink);
  font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums;
}
.an-panel-close {
  margin-left: auto; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 8px;
  display: grid; place-items: center; cursor: pointer; background: none; color: var(--an-muted);
}
.an-panel-close:hover { background: var(--an-surface-2); color: var(--an-ink); }
.an-panel-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  /* room for the launcher button, which floats over the panel's bottom corner */
  padding: 6px 0 76px;
}
.an-panel-list { list-style: none; margin: 0; padding: 0 8px; }
.an-panel-row {
  display: flex; align-items: flex-start; gap: 11px; width: 100%;
  margin: 0; padding: 9px 8px; border: 0; border-radius: 8px;
  background: none; cursor: pointer; text-align: left;
}
.an-panel-row:hover { background: var(--an-surface-2); }
.an-panel-row--open { background: color-mix(in srgb, var(--an-accent) 9%, var(--an-surface)); }
.an-panel-row--open:hover { background: color-mix(in srgb, var(--an-accent) 13%, var(--an-surface)); }
.an-panel-row:focus { outline: none; }
.an-panel-row:focus-visible { box-shadow: inset 0 0 0 2px var(--an-accent); }
.an-panel-thumb {
  flex: none; width: 56px; height: 42px; border-radius: 6px; overflow: hidden;
  display: grid; place-items: center;
  background: var(--an-surface-2); color: var(--an-muted); box-shadow: inset 0 0 0 1px var(--an-border);
}
.an-panel-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
.an-panel-row--hidden .an-panel-thumb img { opacity: .55; }
.an-panel-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.an-panel-title {
  font-weight: 600; line-height: 1.3; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.an-panel-num { color: var(--an-muted); font-weight: 600; }
.an-panel-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; color: var(--an-muted); }
.an-panel-badge {
  display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px; border-radius: 999px; white-space: nowrap;
  font-size: 11px; font-weight: 600; color: var(--an-ink);
  background: color-mix(in srgb, var(--an-c) 14%, var(--an-surface));
}
.an-panel-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--an-c); }
.an-panel-who { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.an-panel-flag {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; color: var(--an-muted); line-height: 1.35;
}
.an-panel-flag::before {
  content: ""; flex: none; width: 10px; height: 10px; border-radius: 50%;
  border: 1.5px dashed var(--an-muted);
}
.an-panel-flag--moved::before { border-color: var(--an-status-in_progress); }
.an-panel-state, .an-panel-error {
  display: flex; align-items: center; gap: 8px; margin: 10px 16px; font-size: 13px; color: var(--an-muted);
}
.an-panel-error { display: block; padding: 8px 10px; border-radius: 7px; color: #b42318; background: #fef3f2; }
.an-panel-error--full { margin-top: 16px; }
.an-panel-link {
  padding: 0; border: 0; background: none; cursor: pointer;
  font-weight: 600; text-decoration: underline; text-underline-offset: 2px;
}
.an-panel-empty {
  display: grid; justify-items: center; gap: 8px; padding: 48px 24px; text-align: center; color: var(--an-muted);
}
.an-panel-empty svg { color: var(--an-status-resolved); }
.an-panel-empty-title { font-size: 14px; font-weight: 600; color: var(--an-ink); }
.an-panel-spinner {
  display: inline-block; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid var(--an-border); border-top-color: var(--an-muted);
  animation: an-panel-spin .7s linear infinite;
}
@keyframes an-panel-spin { to { transform: rotate(360deg); } }
.an-panel-drawer :focus-visible { outline: 2px solid var(--an-accent); outline-offset: 2px; }
.an-panel-drawer .an-panel-row:focus-visible { outline: none; }
@media (max-width: ${PANEL_NARROW}px) {
  .an-panel-drawer {
    top: auto; left: 0; width: auto; height: ${Math.round(SHEET_HEIGHT * 100)}vh;
    border-left: 0; border-top: 1px solid var(--an-border); border-radius: 14px 14px 0 0;
    box-shadow: 0 -12px 32px rgba(0,0,0,.16), 0 -1px 4px rgba(0,0,0,.06);
  }
}
@media (prefers-reduced-motion: reduce) { .an-panel-spinner { animation: none; } }
`;
