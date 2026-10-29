import { h, render } from 'preact';
import { ACTIVATION_PARAM, type Reporter, type WidgetConfig } from '@annotate/shared';
import { createApi } from './api';
import { installConsoleCapture } from './capture/env';
import { App, patchHistory, type Activation, type Bridge } from './ui/App';
import { APP_CSS } from './ui/styles';
import { BASE_CSS } from './ui/theme';
import { accessKeyFor, loadReporter, storageGet, storageRemove, storageSet } from './ui/storage';

const HOST_TAG = 'annotate-widget';

// currentScript is only set while a classic script runs, so read it first thing.
// Module scripts (the dev page) have none: fall back to the tag that carries data-project.
const script =
  (document.currentScript as HTMLScriptElement | null) ??
  document.querySelector<HTMLScriptElement>('script[data-project]');

function readConfig(el: HTMLScriptElement | null): WidgetConfig | null {
  if (!el) return null;
  const d = el.dataset;
  const endpoint = (d.endpoint || '').trim() || (el.src ? new URL(el.src, location.href).origin : '');
  const projectKey = (d.project || '').trim();
  if (!endpoint || !projectKey) return null;
  return {
    endpoint,
    projectKey,
    accessKey: (d.access || '').trim() || undefined,
    // Present means on (the WP plugin writes data-always-on="true"), unless it says "false".
    alwaysOn: d.alwaysOn !== undefined && d.alwaysOn.trim().toLowerCase() !== 'false',
    reporter: {
      name: (d.reporterName || '').trim() || undefined,
      email: (d.reporterEmail || '').trim() || undefined,
    },
    position: d.position === 'bottom-left' ? 'bottom-left' : 'bottom-right',
  };
}

/** Reads ?annotate=<key>, stores it for this project and strips it from the address bar. */
function takeUrlKey(projectKey: string): string | null {
  let url: URL;
  try {
    url = new URL(location.href);
  } catch {
    return null;
  }
  if (!url.searchParams.has(ACTIVATION_PARAM)) return null;
  const key = (url.searchParams.get(ACTIVATION_PARAM) || '').trim();
  url.searchParams.delete(ACTIVATION_PARAM);
  try {
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  } catch {
    /* sandboxed or unusual URL schemes */
  }
  if (!key) return null;
  storageSet(accessKeyFor(projectKey), key);
  return key;
}

function resolveActivation(cfg: WidgetConfig): { accessKey: string; activation: Activation } | null {
  const fromUrl = takeUrlKey(cfg.projectKey);
  if (cfg.alwaysOn && cfg.accessKey) return { accessKey: cfg.accessKey, activation: 'always-on' };
  if (fromUrl) return { accessKey: fromUrl, activation: 'url' };
  const stored = storageGet(accessKeyFor(cfg.projectKey));
  if (stored) return { accessKey: stored, activation: 'storage' };
  return null;
}

function createHost(): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement(HOST_TAG);
  // A 0×0 fixed box: UI inside is position:fixed, so nothing outside it blocks page clicks.
  const s = host.style;
  for (const [prop, value] of [
    ['all', 'initial'],
    ['display', 'block'],
    ['position', 'fixed'],
    ['top', '0'],
    ['left', '0'],
    ['width', '0'],
    ['height', '0'],
    ['overflow', 'visible'],
    ['z-index', '2147483000'],
  ] as const) {
    s.setProperty(prop, value, 'important');
  }
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = BASE_CSS + APP_CSS;
  root.appendChild(style);
  document.documentElement.appendChild(host);
  return { host, root };
}

function mount(cfg: WidgetConfig, accessKey: string, activation: Activation): void {
  if (document.querySelector(HOST_TAG)) return; // already loaded (e.g. plugin + a manual tag)
  const { host, root } = createHost();
  const api = createApi({ endpoint: cfg.endpoint, projectKey: cfg.projectKey, accessKey });

  const bridge: Bridge = { queue: [] };
  window.Annotate = {
    open: () => (bridge.open ? bridge.open() : bridge.queue.push((b) => b.open?.())),
    showPins: (on: boolean) => (bridge.showPins ? bridge.showPins(on) : bridge.queue.push((b) => b.showPins?.(on))),
  };

  const prefill: Partial<Reporter> = cfg.reporter ?? {};
  const saved = loadReporter();
  const complete = prefill.name && prefill.email ? { name: prefill.name, email: prefill.email } : null;

  const turnOff = () => {
    storageRemove(accessKeyFor(cfg.projectKey));
    render(null, root);
    host.remove();
    delete window.Annotate;
  };

  patchHistory();
  render(
    h(App, {
      api,
      host,
      activation,
      position: cfg.position ?? 'bottom-right',
      initialReporter: saved ?? complete,
      reporterPrefill: prefill,
      bridge,
      onTurnOff: turnOff,
    }),
    root,
  );
}

function boot(): void {
  const cfg = readConfig(script);
  if (!cfg) return;
  const active = resolveActivation(cfg);
  if (!active) return; // inert: no UI, no network calls
  installConsoleCapture();
  const go = () => mount(cfg, active.accessKey, active.activation);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
  else go();
}

boot();
