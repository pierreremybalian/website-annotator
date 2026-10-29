// Popover for one issue: screenshot, status, review banner, notes, comments, reply. Only used by Pins.tsx.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Comment, IssueDetail, IssueStatus, IssueSummary, Reporter } from '@annotate/shared';
import type { WidgetApi } from '../types';

/**
 * Where the popover goes:
 *   pin  = beside a pin (viewport position of the pin's box);
 *   edge = to the left of a vertical edge at x (the issues panel), top-aligned with `top`. With no room
 *          there (narrow screens, where the panel is a bottom sheet) it sits at the top of the screen.
 */
export type PopoverAnchor =
  | { kind: 'pin'; left: number; top: number; size: number }
  | { kind: 'edge'; x: number; top: number };

export interface PinPopoverProps {
  issue: IssueSummary;
  detached: boolean;
  /** The element exists but isn't visible at this screen size (opened from the panel). */
  hidden?: boolean;
  anchor: PopoverAnchor;
  /** The area the popover may use (the viewport minus the issues panel, for pin anchors). */
  vw: number;
  vh: number;
  api: WidgetApi;
  reporter: Reporter | null;
  onReporterChange(reporter: Reporter): void;
  onClose(): void;
  /** Last loaded detail for this issue, shown immediately while it refreshes. */
  cached?: IssueDetail;
  onDetail(detail: IssueDetail): void;
  /** Confirm/reopen succeeded: the issue as the Worker now has it. */
  onUpdated(issue: IssueSummary): void;
}

const WIDTH = 340;
const GAP = 8;
const MARGIN = 8;

export const STATUS_LABEL: Record<IssueStatus, string> = {
  new: 'New',
  in_progress: 'In progress',
  review: 'Ready for review',
  resolved: 'Resolved',
  archived: 'Archived',
};

export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

function fullDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleString();
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Keep keystrokes typed into our fields away from the host page's keyboard shortcuts. */
const shield = (e: Event) => e.stopPropagation();

function place(anchor: PopoverAnchor, w: number, h: number, vw: number, vh: number): { left: number; top: number } {
  const maxLeft = Math.max(MARGIN, vw - MARGIN - w);
  const maxTop = Math.max(MARGIN, vh - MARGIN - h);
  const clamp = (left: number, top: number) => ({
    left: Math.min(Math.max(left, MARGIN), maxLeft),
    top: Math.min(Math.max(top, MARGIN), maxTop),
  });
  if (anchor.kind === 'edge') {
    const beside = anchor.x - GAP - w;
    return beside >= MARGIN ? clamp(beside, anchor.top) : clamp((vw - w) / 2, MARGIN);
  }
  const pin = anchor;
  const right = pin.left + pin.size + GAP;
  const leftSide = pin.left - GAP - w;
  let left: number;
  let top: number;
  if (right + w <= vw - MARGIN) {
    left = right;
    top = pin.top;
  } else if (leftSide >= MARGIN) {
    left = leftSide;
    top = pin.top;
  } else {
    // Not enough room beside the pin (narrow screens): go below it, else above it.
    left = Math.min(Math.max(pin.left, MARGIN), maxLeft);
    const below = pin.top + pin.size + GAP;
    const above = pin.top - GAP - h;
    top = below + h <= vh - MARGIN ? below : above >= MARGIN ? above : below;
  }
  return clamp(left, top);
}

function errorText(prefix: string, err: unknown): string {
  const msg = err instanceof Error ? err.message.trim() : '';
  return `${prefix} ${msg || 'Try again.'}`;
}

type ReviewStep = 'ask' | 'confirm' | 'reopen';

export function PinPopover(props: PinPopoverProps) {
  const { issue, detached, hidden, anchor, vw, vh, api, reporter, onReporterChange, onClose, cached } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const lightboxRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Latest callbacks for listeners registered once.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onDetailRef = useRef(props.onDetail);
  onDetailRef.current = props.onDetail;
  const onUpdatedRef = useRef(props.onUpdated);
  onUpdatedRef.current = props.onUpdated;
  const aliveRef = useRef(true);
  useEffect(() => () => {
    aliveRef.current = false;
  }, []);

  const [detail, setDetail] = useState<IssueDetail | null>(cached ?? null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const [posted, setPosted] = useState<Comment[]>([]);

  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Review banner (status 'review'): confirm or reopen with a note.
  const [step, setStep] = useState<ReviewStep>('ask');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'confirm' | 'reopen' | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<'confirmed' | 'reopened' | null>(null);

  const [lightbox, setLightbox] = useState(false);
  const lightboxOpen = useRef(false);
  lightboxOpen.current = lightbox;
  const [lbState, setLbState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [thumbError, setThumbError] = useState(false);

  const [size, setSize] = useState({ w: WIDTH, h: 0 });

  // Load the full issue (notes + comments). The summary renders right away.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(false);
    api.getIssue(issue.id).then(
      (d) => {
        if (!alive) return;
        setDetail(d);
        setLoading(false);
        onDetailRef.current(d);
      },
      (err) => {
        if (!alive) return;
        console.warn('[annotate] could not load issue', err);
        setLoading(false);
        setLoadError(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, issue.id, reload]);

  // Measure for flip/clamp; re-measure when content (image, comments) changes height.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Esc and outside clicks close (the lightbox first, if open).
  useEffect(() => {
    const rootNode = rootRef.current?.getRootNode();
    const shadow = rootNode instanceof ShadowRoot ? rootNode : null;
    const host = shadow?.host ?? null;
    const isInside = (e: Event) =>
      e.composedPath().some(
        (n) =>
          n === rootRef.current ||
          n === lightboxRef.current ||
          // Pins and panel rows switch the popover themselves.
          (n instanceof Element && (n.hasAttribute('data-an-pin') || n.hasAttribute('data-an-row'))),
      );
    // Document level: events from inside the shadow root are retargeted to the host (and the path is
    // opaque if the root is closed), so leave those to the shadow-root listener below.
    const onDocDown = (e: Event) => {
      if (host && e.composedPath().includes(host)) return;
      if (!shadow && isInside(e)) return;
      onCloseRef.current();
    };
    const onShadowDown = (e: Event) => {
      if (!isInside(e)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (lightboxOpen.current) setLightbox(false);
      else onCloseRef.current();
    };
    document.addEventListener('pointerdown', onDocDown, true);
    shadow?.addEventListener('pointerdown', onShadowDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDocDown, true);
      shadow?.removeEventListener('pointerdown', onShadowDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const comments = useMemo(() => {
    const seen = new Set<string>();
    const all: Comment[] = [];
    for (const c of [...(detail?.comments ?? []), ...posted]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      all.push(c);
    }
    return all.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }, [detail, posted]);

  // Keep the newest reply in view after sending.
  useEffect(() => {
    if (posted.length && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [posted.length]);

  /** The saved reporter, or the name + email typed here (saved via onReporterChange); null if those aren't valid yet. */
  function takeReporter(): Reporter | null {
    if (reporter) return reporter;
    const n = name.trim();
    const em = email.trim();
    if (!n || !EMAIL_RE.test(em)) return null;
    const who = { name: n, email: em };
    onReporterChange(who);
    return who;
  }
  const NEED_WHO = 'Add your name and a valid email first.';

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    const who = takeReporter();
    if (!who) {
      setSendError(NEED_WHO);
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const c = await api.addComment(issue.id, body, who);
      setPosted((p) => [...p, c]);
      setText('');
      if (detail) onDetailRef.current({ ...detail, comments: [...detail.comments, c] });
    } catch (err) {
      console.warn('[annotate] could not post comment', err);
      setSendError("Couldn't send your reply. Try again.");
    } finally {
      setSending(false);
      textRef.current?.focus();
    }
  }

  const onTextKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  async function confirmFix(who: Reporter) {
    setBusy('confirm');
    setReviewError(null);
    try {
      const updated = await api.confirmIssue(issue.id, who);
      if (!aliveRef.current) return;
      setOutcome('confirmed');
      setDetail((d) => (d ? { ...d, status: updated.status } : d));
      onUpdatedRef.current(updated);
    } catch (err) {
      if (!aliveRef.current) return;
      console.warn('[annotate] could not confirm issue', err);
      setReviewError(errorText("Couldn't confirm.", err));
      setReload((n) => n + 1); // the status may have changed elsewhere
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  }

  function looksGood() {
    if (busy) return;
    const who = takeReporter();
    if (who) void confirmFix(who);
    else {
      setReviewError(null);
      setStep('confirm');
    }
  }

  function submitConfirm() {
    if (busy) return;
    const who = takeReporter();
    if (!who) {
      setReviewError(NEED_WHO);
      nameRef.current?.focus();
      return;
    }
    void confirmFix(who);
  }

  async function submitReopen() {
    if (busy) return;
    const body = note.trim();
    if (!body) {
      setReviewError('Describe what still looks wrong.');
      noteRef.current?.focus();
      return;
    }
    const who = takeReporter();
    if (!who) {
      setReviewError(NEED_WHO);
      return;
    }
    setBusy('reopen');
    setReviewError(null);
    try {
      const updated = await api.reopenIssue(issue.id, body, who);
      if (!aliveRef.current) return;
      setOutcome('reopened');
      setNote('');
      setDetail((d) => (d ? { ...d, status: updated.status } : d));
      onUpdatedRef.current(updated);
      setReload((n) => n + 1); // the note is posted as a comment
    } catch (err) {
      if (!aliveRef.current) return;
      console.warn('[annotate] could not reopen issue', err);
      setReviewError(errorText("Couldn't reopen.", err));
      setReload((n) => n + 1);
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  }

  const onNoteKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submitReopen();
    }
  };

  const cancelStep = () => {
    setStep('ask');
    setReviewError(null);
  };

  // Focus the first field of a review step.
  useEffect(() => {
    if (step === 'reopen') noteRef.current?.focus();
    else if (step === 'confirm') nameRef.current?.focus();
  }, [step]);

  const pos = place(anchor, size.w || WIDTH, size.h, vw, vh);
  // Pins keeps the summary in sync with loaded details and confirm/reopen results.
  const status = issue.status;
  const showReview = status === 'review' || outcome !== null;
  const askWhoInBanner = !reporter && status === 'review' && !outcome && step !== 'ask';

  const whoFields = (cls: string, focusRef?: typeof nameRef) => (
    <div class={cls}>
      <input
        ref={focusRef}
        type="text"
        placeholder="Your name"
        aria-label="Your name"
        autocomplete="name"
        value={name}
        onInput={(e) => setName(e.currentTarget.value)}
        onKeyDown={shield}
        onKeyUp={shield}
      />
      <input
        type="email"
        placeholder="Email"
        aria-label="Email"
        autocomplete="email"
        value={email}
        onInput={(e) => setEmail(e.currentTarget.value)}
        onKeyDown={shield}
        onKeyUp={shield}
      />
    </div>
  );
  const contextUrl = detail?.contextUrl;
  const notes = detail?.notes?.trim();
  const createdAt = issue.createdAt;

  return (
    <>
      <div
        ref={rootRef}
        class="an-pop"
        role="dialog"
        aria-label={`Issue #${issue.number}`}
        style={{ left: `${pos.left}px`, top: `${pos.top}px`, visibility: size.h ? 'visible' : 'hidden' }}
      >
        <button type="button" class="an-pop-close" aria-label="Close" onClick={() => onClose()}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>

        <div class="an-pop-scroll" ref={scrollRef}>
          <button
            type="button"
            class="an-pop-thumb"
            disabled={!contextUrl}
            title={contextUrl ? 'View full screenshot' : undefined}
            onClick={() => {
              setLbState('loading');
              setLightbox(true);
            }}
          >
            {thumbError ? (
              <span class="an-pop-thumb-msg">Screenshot unavailable</span>
            ) : (
              <img src={issue.screenshotUrl} alt="" loading="lazy" onError={() => setThumbError(true)} />
            )}
          </button>

          <div class="an-pop-body">
            <div class="an-pop-head">
              <h2 class="an-pop-title">
                <span class="an-pop-num">#{issue.number}</span> {issue.title || 'Untitled'}
              </h2>
              <span class={`an-pop-badge an-pin-st-${status}`}>
                <i class="an-pop-dot" />
                {STATUS_LABEL[status] ?? status}
              </span>
            </div>
            <div class="an-pop-meta">
              {issue.reporterName || 'Someone'}
              {createdAt && (
                <>
                  {' · '}
                  <time dateTime={createdAt} title={fullDate(createdAt)}>
                    {timeAgo(createdAt)}
                  </time>
                </>
              )}
            </div>

            {showReview && (
              <div
                class={`an-pop-review${outcome ? ' an-pop-review--done' : ''}`}
                role={outcome ? 'status' : 'group'}
                aria-label={outcome ? undefined : 'Review the fix'}
              >
                {outcome === 'confirmed' && (
                  <p class="an-pop-review-title">
                    <span class="an-pop-review-check" aria-hidden="true">✓</span> Thanks! Marked as done.
                  </p>
                )}
                {outcome === 'reopened' && (
                  <p class="an-pop-review-title">Thanks. It's reopened so the team can take another look.</p>
                )}
                {!outcome && (
                  <>
                    <p class="an-pop-review-title">Marked as fixed. Does it look right now?</p>
                    {step === 'ask' && (
                      <div class="an-pop-review-actions">
                        <button
                          type="button"
                          class="an-pop-btn an-pop-btn--ok"
                          disabled={busy !== null}
                          onClick={looksGood}
                        >
                          {busy === 'confirm' ? 'Confirming…' : 'Looks good ✓'}
                        </button>
                        <button
                          type="button"
                          class="an-pop-btn an-pop-btn--ghost"
                          disabled={busy !== null}
                          onClick={() => {
                            setReviewError(null);
                            setStep('reopen');
                          }}
                        >
                          Still broken
                        </button>
                      </div>
                    )}
                    {step === 'confirm' && (
                      <form
                        class="an-pop-review-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          submitConfirm();
                        }}
                      >
                        <div class="an-pop-review-label">Add your name to confirm</div>
                        {whoFields('an-pop-review-who', nameRef)}
                        <div class="an-pop-review-actions">
                          <button type="submit" class="an-pop-btn an-pop-btn--ok" disabled={busy !== null}>
                            {busy === 'confirm' ? 'Confirming…' : 'Confirm fix'}
                          </button>
                          <button type="button" class="an-pop-btn an-pop-btn--ghost" disabled={busy !== null} onClick={cancelStep}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    )}
                    {step === 'reopen' && (
                      <form
                        class="an-pop-review-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void submitReopen();
                        }}
                      >
                        <textarea
                          ref={noteRef}
                          rows={3}
                          required
                          placeholder="What still looks wrong?"
                          aria-label="What still looks wrong?"
                          value={note}
                          disabled={busy !== null}
                          onInput={(e) => setNote(e.currentTarget.value)}
                          onKeyDown={onNoteKey}
                          onKeyUp={shield}
                        />
                        {!reporter && whoFields('an-pop-review-who')}
                        <div class="an-pop-review-actions">
                          <button type="submit" class="an-pop-btn an-pop-btn--danger" disabled={busy !== null || !note.trim()}>
                            {busy === 'reopen' ? 'Reopening…' : 'Reopen issue'}
                          </button>
                          <button type="button" class="an-pop-btn an-pop-btn--ghost" disabled={busy !== null} onClick={cancelStep}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    )}
                    {reviewError && (
                      <div class="an-pop-error an-pop-review-error" role="alert">
                        {reviewError}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {hidden && (
              <div class="an-pop-note">
                Not visible at this screen size, reported at {issue.anchor.viewportWidth}px. Resize the window to see it
                on the page.
              </div>
            )}
            {detached && !hidden && (
              <div class="an-pop-note">
                Position may have moved: the page changed since this was reported, so the pin shows where it was
                originally.
              </div>
            )}

            {notes && <p class="an-pop-notes">{notes}</p>}

            <div class="an-pop-section">
              Comments{comments.length ? ` (${comments.length})` : ''}
              {loading && detail && <span class="an-pop-refresh">Refreshing…</span>}
            </div>

            {!detail && loading && (
              <div class="an-pop-state">
                <span class="an-pop-spinner" aria-hidden="true" /> Loading comments…
              </div>
            )}
            {loadError && (
              <div class="an-pop-state an-pop-error">
                {detail ? "Couldn't refresh comments." : "Couldn't load notes and comments."}{' '}
                <button type="button" class="an-pop-link" onClick={() => setReload((n) => n + 1)}>
                  Retry
                </button>
              </div>
            )}
            {(detail || posted.length > 0) && comments.length === 0 && (
              <div class="an-pop-state">No comments yet.</div>
            )}
            {comments.length > 0 && (
              <ol class="an-pop-comments">
                {comments.map((c) => (
                  <li key={c.id} class="an-pop-comment">
                    <div class="an-pop-comment-head">
                      <span class="an-pop-comment-author">{c.author}</span>
                      {c.via === 'agent' && (
                        <span class="an-pop-tag" title="Posted by a coding agent">
                          agent
                        </span>
                      )}
                      <time dateTime={c.createdAt} title={fullDate(c.createdAt)}>
                        {timeAgo(c.createdAt)}
                      </time>
                    </div>
                    <div class="an-pop-comment-text">{c.text}</div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        <form
          class="an-pop-reply"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {/* The review banner asks for the same name + email while it's open: one set of fields at a time. */}
          {!reporter && !askWhoInBanner && whoFields('an-pop-reply-who')}
          <textarea
            ref={textRef}
            rows={2}
            placeholder="Write a reply…"
            aria-label="Reply"
            value={text}
            disabled={sending}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={onTextKey}
            onKeyUp={shield}
          />
          {sendError && (
            <div class="an-pop-error an-pop-reply-error" role="alert">
              {sendError}
            </div>
          )}
          <div class="an-pop-reply-actions">
            {issue.shortUrl ? (
              <a class="an-pop-link" href={issue.shortUrl} target="_blank" rel="noopener">
                Open in Trello
                <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                  <path d="M6 3h7v7M13 3L4 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                </svg>
              </a>
            ) : (
              <span />
            )}
            <span class="an-pop-reply-send">
              <span class="an-pop-hint">{IS_MAC ? '⌘' : 'Ctrl'}+Enter</span>
              <button type="submit" class="an-pop-btn" disabled={sending || !text.trim()}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </span>
          </div>
        </form>
      </div>

      {lightbox && contextUrl && (
        <div
          ref={lightboxRef}
          class="an-pop-lightbox"
          role="dialog"
          aria-label="Full screenshot"
          onClick={() => setLightbox(false)}
        >
          {lbState === 'loading' && (
            <div class="an-pop-lightbox-msg">
              <span class="an-pop-spinner" aria-hidden="true" /> Loading screenshot…
            </div>
          )}
          {lbState === 'error' && <div class="an-pop-lightbox-msg">Couldn't load the screenshot.</div>}
          <img
            src={contextUrl}
            alt={`Screenshot for issue #${issue.number}`}
            style={{ display: lbState === 'ready' ? 'block' : 'none' }}
            onLoad={() => setLbState('ready')}
            onError={() => setLbState('error')}
            onClick={(e) => e.stopPropagation()}
          />
          <button type="button" class="an-pop-lightbox-close" aria-label="Close screenshot">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}

// Stacking inside the pin layer: highlight, pins (1), issues panel (2), popover (3), lightbox (4).
export const POPOVER_CSS = `
.an-pop {
  position: fixed;
  z-index: 3;
  width: ${WIDTH}px;
  max-width: calc(100vw - ${MARGIN * 2}px);
  max-height: calc(100vh - ${MARGIN * 2}px);
  display: flex;
  flex-direction: column;
  background: var(--an-surface);
  color: var(--an-ink);
  border: 1px solid var(--an-border);
  border-radius: var(--an-radius);
  box-shadow: var(--an-shadow);
  pointer-events: auto;
  overflow: hidden;
  font: 14px/1.4 var(--an-font);
  text-align: left;
}
.an-pop button, .an-pop input, .an-pop textarea { font: inherit; color: inherit; }
.an-pop-close {
  position: absolute; top: 8px; right: 8px; z-index: 1;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: 50%;
  display: grid; place-items: center; cursor: pointer;
  background: rgba(255,255,255,.92); color: var(--an-ink);
  box-shadow: 0 1px 3px rgba(0,0,0,.2);
}
.an-pop-close:hover { background: #fff; }
.an-pop-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.an-pop-thumb {
  display: grid; place-items: center; width: 100%; min-height: 72px; max-height: 180px;
  padding: 0; margin: 0; border: 0; border-bottom: 1px solid var(--an-border);
  background: var(--an-surface-2); overflow: hidden; cursor: zoom-in;
}
.an-pop-thumb:disabled { cursor: default; }
.an-pop-thumb img { display: block; max-width: 100%; max-height: 180px; object-fit: contain; }
.an-pop-thumb-msg { color: var(--an-muted); font-size: 12px; }
.an-pop-body { padding: 12px 14px 4px; }
.an-pop-head { display: flex; align-items: flex-start; gap: 8px; }
.an-pop-title { flex: 1; margin: 0; font-size: 15px; font-weight: 650; line-height: 1.3; overflow-wrap: anywhere; }
.an-pop-num { color: var(--an-muted); font-weight: 600; }
.an-pop-badge {
  flex: none; display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 8px; border-radius: 999px; white-space: nowrap;
  font-size: 12px; font-weight: 600;
  background: color-mix(in srgb, var(--an-c) 14%, var(--an-surface));
  color: var(--an-ink);
}
.an-pop-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--an-c); }
.an-pop-meta { margin-top: 3px; font-size: 12px; color: var(--an-muted); }
.an-pop-note {
  margin-top: 10px; padding: 7px 9px; border: 1px dashed var(--an-status-in_progress); border-radius: 6px;
  font-size: 12px; background: color-mix(in srgb, var(--an-status-in_progress) 10%, var(--an-surface));
}
.an-pop-notes { margin: 10px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.an-pop-review {
  margin-top: 10px; padding: 10px 11px 11px; border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--an-status-review) 45%, var(--an-surface));
  border-left-width: 4px; border-left-color: var(--an-status-review);
  background: color-mix(in srgb, var(--an-status-review) 9%, var(--an-surface));
}
.an-pop-review--done {
  border-color: color-mix(in srgb, var(--an-status-resolved) 45%, var(--an-surface));
  border-left-color: var(--an-status-resolved);
  background: color-mix(in srgb, var(--an-status-resolved) 9%, var(--an-surface));
}
.an-pop-review-title { margin: 0; font-size: 13px; font-weight: 650; line-height: 1.35; }
.an-pop-review-check {
  display: inline-grid; place-items: center; width: 18px; height: 18px; margin-right: 2px; border-radius: 50%;
  background: var(--an-status-resolved); color: #fff; font-size: 11px; vertical-align: -3px;
}
.an-pop-review-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 9px; }
.an-pop-review-form { margin: 8px 0 0; }
.an-pop-review-label { margin-bottom: 6px; font-size: 12px; color: var(--an-muted); }
.an-pop-review-who { display: flex; gap: 6px; margin-top: 6px; }
.an-pop-review-form .an-pop-review-label + .an-pop-review-who { margin-top: 0; }
.an-pop-review-who input { flex: 1; min-width: 0; }
.an-pop-review input, .an-pop-review textarea {
  display: block; width: 100%; padding: 7px 9px; margin: 0;
  border: 1px solid var(--an-border); border-radius: 7px; background: var(--an-surface);
  font-size: 13px; outline: none;
}
.an-pop-review textarea { resize: vertical; min-height: 60px; max-height: 160px; }
.an-pop-review input:focus, .an-pop-review textarea:focus {
  border-color: var(--an-status-review); box-shadow: 0 0 0 3px color-mix(in srgb, var(--an-status-review) 20%, transparent);
}
.an-pop-review-error { margin-top: 8px; font-size: 12px; }
.an-pop-section {
  display: flex; align-items: baseline; gap: 8px;
  margin: 14px 0 6px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  color: var(--an-muted);
}
.an-pop-refresh { font-weight: 500; letter-spacing: 0; text-transform: none; }
.an-pop-state { display: flex; align-items: center; gap: 6px; padding: 4px 0 10px; font-size: 13px; color: var(--an-muted); }
.an-pop-error { color: #b42318; }
.an-pop-comments { list-style: none; margin: 0; padding: 0 0 8px; }
.an-pop-comment { padding: 8px 0; border-top: 1px solid var(--an-border); }
.an-pop-comment:first-child { border-top: 0; padding-top: 2px; }
.an-pop-comment-head { display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: var(--an-muted); }
.an-pop-comment-author { font-weight: 650; color: var(--an-ink); }
.an-pop-tag {
  align-self: center; padding: 1px 5px; border-radius: 4px;
  font-size: 10px; font-weight: 700; line-height: 14px; letter-spacing: .04em; text-transform: uppercase;
  background: color-mix(in srgb, var(--an-status-review) 14%, var(--an-surface)); color: var(--an-ink);
}
.an-pop-comment-text { margin-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere; }
.an-pop-reply { flex: none; padding: 10px 14px 12px; border-top: 1px solid var(--an-border); background: var(--an-surface); }
.an-pop-reply-who { display: flex; gap: 6px; margin-bottom: 6px; }
.an-pop-reply-who input { flex: 1; min-width: 0; }
.an-pop-reply input, .an-pop-reply textarea {
  display: block; width: 100%; padding: 7px 9px; margin: 0;
  border: 1px solid var(--an-border); border-radius: 7px; background: var(--an-surface);
  font-size: 13px; outline: none;
}
.an-pop-reply textarea { resize: vertical; min-height: 44px; max-height: 160px; }
.an-pop-reply input:focus, .an-pop-reply textarea:focus {
  border-color: var(--an-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--an-accent) 20%, transparent);
}
.an-pop-reply-error { margin-top: 6px; font-size: 12px; }
.an-pop-reply-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
.an-pop-reply-send { display: inline-flex; align-items: center; gap: 8px; }
.an-pop-hint { font-size: 11px; color: var(--an-muted); }
/* .an-pop .an-pop-btn: beats the ".an-pop button { color: inherit }" reset above. */
.an-pop .an-pop-btn {
  padding: 6px 14px; border: 0; border-radius: 7px; cursor: pointer;
  background: var(--an-accent); color: var(--an-accent-ink); font-weight: 600; font-size: 13px;
}
.an-pop .an-pop-btn:disabled { opacity: .5; cursor: default; }
.an-pop .an-pop-btn--ok { background: var(--an-status-resolved); color: #fff; }
.an-pop .an-pop-btn--danger { background: var(--an-ink); color: #fff; }
.an-pop .an-pop-btn--ghost { background: var(--an-surface); color: var(--an-ink); box-shadow: inset 0 0 0 1px var(--an-border); }
.an-pop .an-pop-btn--ghost:hover:not(:disabled) { background: var(--an-surface-2); }
.an-pop-link {
  display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; cursor: pointer;
  color: var(--an-ink); font-size: 13px; font-weight: 600; text-decoration: underline;
  text-decoration-color: var(--an-border); text-underline-offset: 3px;
}
.an-pop-link:hover { text-decoration-color: currentColor; }
.an-pop :focus-visible { outline: 2px solid var(--an-accent); outline-offset: 2px; }
/* Fields have their own focus ring (border + glow). */
.an-pop :is(input, textarea):focus-visible { outline: none; }
.an-pop-spinner {
  display: inline-block; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid var(--an-border); border-top-color: var(--an-muted);
  animation: an-pop-spin .7s linear infinite;
}
@keyframes an-pop-spin { to { transform: rotate(360deg); } }
.an-pop-lightbox {
  position: fixed; inset: 0; z-index: 4; pointer-events: auto;
  display: grid; place-items: center; padding: 24px;
  background: rgba(15,17,21,.82); cursor: zoom-out;
}
.an-pop-lightbox img {
  max-width: 100%; max-height: calc(100vh - 48px); border-radius: 6px;
  box-shadow: 0 20px 60px rgba(0,0,0,.5); background: #fff; cursor: default;
}
.an-pop-lightbox-msg { display: flex; align-items: center; gap: 8px; color: #fff; font-size: 14px; }
.an-pop-lightbox-close {
  position: absolute; top: 14px; right: 14px; width: 36px; height: 36px; padding: 0; border: 0; border-radius: 50%;
  display: grid; place-items: center; cursor: pointer; background: rgba(255,255,255,.14); color: #fff;
}
.an-pop-lightbox-close:hover { background: rgba(255,255,255,.24); }
@media (prefers-reduced-motion: reduce) { .an-pop-spinner { animation: none; } }
`;
