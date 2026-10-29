import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Anchor, CaptureEnv, CreateIssueMeta, CreateIssueResponse, Rect, Reporter } from '@annotate/shared';
import type { WidgetApi } from '../types';
import { ApiRequestError } from '../api';
import { createAnchor } from '../capture/anchor';
import { buildEnv } from '../capture/env';
import { captureScreenshots, type Screenshots } from '../capture/screenshot';
import { Pins } from './Pins';
import { Selector } from './Selector';
import { Form, Success, type FormInput } from './Form';
import { saveReporter } from './storage';

export type Mode = 'idle' | 'selecting' | 'capturing' | 'form' | 'submitted';
export type Activation = 'always-on' | 'url' | 'storage';

/** Lets index.ts route window.Annotate calls into the mounted App. Calls made before mount are queued. */
export interface Bridge {
  open?: () => void;
  showPins?: (on: boolean) => void;
  queue: Array<(b: Bridge) => void>;
}

interface AppProps {
  api: WidgetApi;
  host: HTMLElement;
  activation: Activation;
  position: 'bottom-left' | 'bottom-right';
  /** Saved (localStorage) or complete prefilled reporter. */
  initialReporter: Reporter | null;
  /** Partial prefill from data-reporter-name / data-reporter-email. */
  reporterPrefill: Partial<Reporter>;
  bridge: Bridge;
  onTurnOff(): void;
}

interface Captured {
  shots: Screenshots;
  previewUrl: string | null;
  anchor: Anchor;
  env: CaptureEnv;
}

const NAV_EVENT = 'annotate:locationchange';
let historyPatched = false;

/** pushState/replaceState don't fire popstate; patch them so SPA navigation updates the pins. */
export function patchHistory(): void {
  if (historyPatched) return;
  historyPatched = true;
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event(NAV_EVENT));
      return result;
    };
  }
}

function fallbackAnchor(rect: Rect): Anchor {
  return {
    selector: null,
    relative: null,
    absolute: { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height },
    viewportWidth: window.innerWidth,
    text: '',
  };
}

function friendlyError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case 'network':
        return `${err.message} Check your connection and retry.`;
      case 'unauthorized':
        return 'This feedback link is no longer valid. Ask the site owner for a new one.';
      case 'forbidden_origin':
        return "Feedback isn't enabled for this site address.";
      case 'token_revoked':
        return 'The Trello connection needs to be renewed by the site owner.';
      case 'rate_limited':
        return 'Too many reports in a short time. Wait a minute and retry.';
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function isEditable(t: EventTarget | undefined): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
}

const LauncherIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <path d="M12 7v6M9 10h6" />
  </svg>
);

export function App(props: AppProps) {
  const { api, host, activation, position, bridge, onTurnOff } = props;
  const side = position === 'bottom-left' ? 'an-left' : 'an-right';

  const [mode, setMode] = useState<Mode>('idle');
  const [menuOpen, setMenuOpen] = useState(false);
  const [showPins, setShowPins] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [pageUrl, setPageUrl] = useState(location.href);
  const [refreshKey, setRefreshKey] = useState(0);
  const [openIssueId, setOpenIssueId] = useState<string | null>(null);
  const [reporter, setReporter] = useState<Reporter | null>(props.initialReporter);
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [result, setResult] = useState<CreateIssueResponse | null>(null);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const capturedRef = useRef(captured);
  capturedRef.current = captured;
  const menuRef = useRef<HTMLDivElement>(null);
  const pageUrlRef = useRef(pageUrl);
  pageUrlRef.current = pageUrl;

  const discardCapture = useCallback(() => {
    const c = capturedRef.current;
    if (c?.previewUrl) URL.revokeObjectURL(c.previewUrl);
    setCaptured(null);
  }, []);

  const startSelecting = useCallback(() => {
    const m = modeRef.current;
    if (m !== 'idle' && m !== 'submitted') return;
    setMenuOpen(false);
    setOpenIssueId(null);
    setResult(null);
    setMode('selecting');
  }, []);

  const cancelSelecting = useCallback(() => setMode('idle'), []);

  const onSelect = useCallback(
    async (rect: Rect) => {
      setMode('capturing');
      // Anchor and env first, synchronously: a scroll or layout shift during the async
      // capture would otherwise misalign them with what the user selected.
      let anchor: Anchor;
      try {
        anchor = createAnchor(rect, host);
      } catch {
        anchor = fallbackAnchor(rect);
      }
      const env = buildEnv();
      const shots = await captureScreenshots(rect, host);
      const previewUrl = shots.ok ? URL.createObjectURL(shots.selection) : null;
      setCaptured({ shots, previewUrl, anchor, env });
      setMode('form');
    },
    [host],
  );

  const onReporterChange = useCallback((r: Reporter) => {
    saveReporter(r);
    setReporter(r);
  }, []);

  const submit = useCallback(
    async (input: FormInput) => {
      const c = capturedRef.current;
      if (!c) throw new Error('Nothing captured.');
      onReporterChange(input.reporter);
      const meta: CreateIssueMeta = {
        title: input.title,
        notes: input.notes,
        reporter: input.reporter,
        anchor: c.anchor,
        env: c.env,
      };
      let res: CreateIssueResponse;
      try {
        res = await api.createIssue(meta, c.shots.selection, c.shots.context);
      } catch (err) {
        throw new Error(friendlyError(err));
      }
      discardCapture();
      setResult(res);
      setRefreshKey((k) => k + 1);
      setMode('submitted');
    },
    [api, discardCapture, onReporterChange],
  );

  const cancelForm = useCallback(() => {
    discardCapture();
    setMode('idle');
  }, [discardCapture]);

  const closeSuccess = useCallback(() => {
    setResult(null);
    setMode('idle');
  }, []);

  const showPin = useCallback(() => {
    if (result) setOpenIssueId(result.id);
    setShowPins(true);
    setResult(null);
    setMode('idle');
  }, [result]);

  // window.Annotate bridge.
  useEffect(() => {
    bridge.open = startSelecting;
    bridge.showPins = (on: boolean) => setShowPins(!!on);
    const queued = bridge.queue.splice(0);
    for (const fn of queued) fn(bridge);
    return () => {
      bridge.open = undefined;
      bridge.showPins = undefined;
    };
  }, [bridge, startSelecting]);

  // Alt+Shift+A starts selecting. e.code because Alt+Shift+A types "Å" on macOS.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyA') {
        if (isEditable(e.composedPath()[0])) return;
        e.preventDefault();
        startSelecting();
      } else if (e.key === 'Escape' && menuRef.current) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [startSelecting]);

  // Close the menu on any click outside it.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const wrap = menuRef.current?.parentElement;
      if (wrap && !e.composedPath().includes(wrap)) setMenuOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [menuOpen]);

  // SPA navigation.
  useEffect(() => {
    const update = () => {
      if (location.href !== pageUrlRef.current) setOpenIssueId(null);
      setPageUrl(location.href);
    };
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    window.addEventListener(NAV_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
      window.removeEventListener(NAV_EVENT, update);
    };
  }, []);

  // Release the preview URL if we unmount mid-form.
  useEffect(() => () => {
    const c = capturedRef.current;
    if (c?.previewUrl) URL.revokeObjectURL(c.previewUrl);
  }, []);

  // Keep the page's keyboard shortcuts from firing while typing in our fields.
  const shieldKeys = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' && isEditable(e.composedPath()[0])) e.stopPropagation();
  };

  const pinsVisible = showPins && (mode === 'idle' || mode === 'submitted');
  const canTurnOff = activation !== 'always-on';

  return (
    <div class="annotate-root" onKeyDown={shieldKeys} onKeyUp={shieldKeys} onKeyPress={shieldKeys}>
      {pinsVisible && (
        <Pins
          api={api}
          pageUrl={pageUrl}
          reporter={reporter}
          onReporterChange={onReporterChange}
          showResolved={showResolved}
          refreshKey={refreshKey}
          openIssueId={openIssueId}
        />
      )}

      {mode === 'idle' && (
        <div class={`an-launcher-wrap ${side}`} data-annotate="launcher">
          {menuOpen && (
            <div class="an-menu" ref={menuRef} role="menu">
              <button type="button" class="an-primary" role="menuitem" onClick={startSelecting}>
                <span>Report an issue</span>
                <span class="an-kbd">⌥⇧A</span>
              </button>
              <hr />
              <button type="button" role="menuitemcheckbox" aria-checked={showPins} onClick={() => setShowPins((v) => !v)}>
                <span>Show pins</span>
                <span class={`an-switch${showPins ? ' on' : ''}`} />
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={showResolved}
                disabled={!showPins}
                onClick={() => setShowResolved((v) => !v)}
              >
                <span>Show resolved</span>
                <span class={`an-switch${showResolved ? ' on' : ''}`} />
              </button>
              {canTurnOff && (
                <>
                  <hr />
                  <button type="button" class="an-danger" role="menuitem" onClick={onTurnOff}>
                    Turn off feedback mode
                  </button>
                </>
              )}
            </div>
          )}
          <button
            type="button"
            class="an-launcher"
            aria-label="Feedback"
            aria-expanded={menuOpen}
            title="Feedback"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <LauncherIcon />
          </button>
        </div>
      )}

      {mode === 'selecting' && <Selector onSelect={onSelect} onCancel={cancelSelecting} />}

      {mode === 'form' && captured && (
        <Form
          side={side}
          previewUrl={captured.previewUrl}
          captureError={captured.shots.ok ? null : captured.shots.error}
          reporter={reporter}
          reporterDraft={props.reporterPrefill}
          submit={submit}
          onCancel={cancelForm}
        />
      )}

      {mode === 'submitted' && result && (
        <Success side={side} result={result} onReportAnother={startSelecting} onShowPin={showPin} onClose={closeSuccess} />
      )}
    </div>
  );
}
