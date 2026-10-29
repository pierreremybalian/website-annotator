// Styles for App, Selector and Form. Injected once with BASE_CSS by index.ts.
export const APP_CSS = `
.an-launcher-wrap { position: fixed; bottom: 20px; z-index: var(--an-z); pointer-events: auto; }
.an-left { left: 20px; }
.an-right { right: 20px; }
.an-launcher {
  width: 44px; height: 44px; border-radius: 50%; border: 0; cursor: pointer;
  background: var(--an-accent); color: var(--an-accent-ink); box-shadow: var(--an-shadow);
  display: grid; place-items: center; transition: transform .15s ease;
}
.an-launcher:hover { transform: scale(1.06); }
.an-launcher:focus-visible, .an-btn:focus-visible, .an-menu button:focus-visible { outline: 2px solid var(--an-accent); outline-offset: 2px; }
.an-launcher svg { width: 20px; height: 20px; }

.an-menu {
  position: absolute; bottom: 54px; min-width: 232px; padding: 6px;
  background: var(--an-surface); border: 1px solid var(--an-border); border-radius: var(--an-radius);
  box-shadow: var(--an-shadow);
}
.an-left .an-menu { left: 0; }
.an-right .an-menu { right: 0; }
.an-menu button {
  all: unset; box-sizing: border-box; width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 8px 10px; border-radius: 6px; cursor: pointer; font: inherit; color: var(--an-ink);
}
.an-menu button:hover { background: var(--an-surface-2); }
.an-menu .an-primary { font-weight: 600; }
.an-menu .an-kbd { color: var(--an-muted); font-size: 12px; }
.an-menu hr { border: 0; border-top: 1px solid var(--an-border); margin: 6px 4px; }
.an-menu .an-danger { color: var(--an-muted); font-size: 13px; }
.an-switch { width: 28px; height: 16px; border-radius: 99px; background: var(--an-border); position: relative; flex: none; transition: background .15s; }
.an-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; transition: transform .15s; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
.an-switch.on { background: var(--an-accent); }
.an-switch.on::after { transform: translateX(12px); }
.an-menu button[disabled] { opacity: .45; cursor: default; }

/* Selector */
.an-selector { position: fixed; inset: 0; z-index: var(--an-z); cursor: crosshair; pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none; }
.an-selector.an-empty { background: rgba(16, 18, 24, .28); }
.an-box { position: absolute; border: 2px solid var(--an-accent); box-shadow: 0 0 0 100vmax rgba(16, 18, 24, .28); border-radius: 2px; }
.an-size {
  position: absolute; padding: 2px 6px; border-radius: 4px; font: 600 11px/16px var(--an-font);
  background: var(--an-ink); color: #fff; white-space: nowrap; pointer-events: none;
}
.an-hint {
  position: fixed; top: 16px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;
  padding: 8px 8px 8px 14px; border-radius: 99px; background: var(--an-ink); color: #fff; font-size: 13px;
  box-shadow: var(--an-shadow); white-space: nowrap; pointer-events: none;
}
.an-hint button { all: unset; pointer-events: auto; cursor: pointer; padding: 3px 10px; border-radius: 99px; background: rgba(255,255,255,.14); font-size: 12px; }
.an-hint button:hover { background: rgba(255,255,255,.24); }

/* Panel (form + success) */
.an-panel {
  position: fixed; bottom: 20px; width: 340px; max-width: calc(100vw - 24px); max-height: calc(100vh - 40px); overflow: auto;
  z-index: var(--an-z); pointer-events: auto; background: var(--an-surface); color: var(--an-ink);
  border: 1px solid var(--an-border); border-radius: var(--an-radius); box-shadow: var(--an-shadow);
}
.an-panel.an-left { left: 20px; right: auto; }
.an-panel.an-right { right: 20px; left: auto; }
.an-panel-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px 0; }
.an-panel-head h2 { margin: 0; font-size: 15px; font-weight: 650; }
.an-x { all: unset; cursor: pointer; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 6px; color: var(--an-muted); font-size: 18px; line-height: 1; }
.an-x:hover { background: var(--an-surface-2); color: var(--an-ink); }
.an-form { display: grid; gap: 10px; padding: 12px 14px 14px; }
.an-preview {
  display: grid; place-items: center; min-height: 64px; max-height: 170px; overflow: hidden; border-radius: 8px;
  border: 1px solid var(--an-border);
  background: repeating-conic-gradient(#f1f2f4 0 25%, #fff 0 50%) 0 0 / 14px 14px;
}
.an-preview img { display: block; max-width: 100%; max-height: 168px; object-fit: contain; }
.an-preview-missing { padding: 14px; color: var(--an-muted); font-size: 12px; text-align: center; }
.an-field { display: grid; gap: 4px; }
.an-field label { font-size: 12px; font-weight: 600; color: var(--an-muted); }
.an-field input, .an-field textarea {
  font: inherit; color: var(--an-ink); background: var(--an-surface); width: 100%;
  border: 1px solid var(--an-border); border-radius: 7px; padding: 8px 10px; outline: none;
}
.an-field textarea { resize: vertical; min-height: 84px; }
.an-field input:focus, .an-field textarea:focus { border-color: var(--an-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--an-accent) 18%, transparent); }
.an-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.an-as { font-size: 12px; color: var(--an-muted); }
.an-link { all: unset; cursor: pointer; color: var(--an-accent); font-size: 12px; text-decoration: underline; text-underline-offset: 2px; }
.an-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 2px; }
.an-hint-keys { font-size: 11px; color: var(--an-muted); }
.an-btn {
  font: inherit; font-weight: 600; border: 0; cursor: pointer; border-radius: 7px; padding: 8px 14px;
  background: var(--an-accent); color: var(--an-accent-ink); display: inline-flex; align-items: center; gap: 8px; text-decoration: none;
}
.an-btn[disabled] { opacity: .7; cursor: default; }
.an-btn.an-ghost { background: var(--an-surface-2); color: var(--an-ink); }
.an-spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: an-spin .7s linear infinite; }
@keyframes an-spin { to { transform: rotate(360deg); } }
.an-error {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-radius: 7px;
  background: #fff1ee; color: #a8321a; font-size: 13px; border: 1px solid #ffd2c7;
}
.an-error button { all: unset; cursor: pointer; font-weight: 600; text-decoration: underline; }
.an-warn { font-size: 12px; color: var(--an-muted); }
.an-success { padding: 12px 12px 14px 14px; display: grid; gap: 12px; }
.an-success-title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 650; }
.an-success-title .an-x { margin-left: auto; }
.an-check { width: 22px; height: 22px; border-radius: 50%; background: var(--an-status-resolved); color: #fff; display: grid; place-items: center; font-size: 13px; }
.an-success-actions { display: flex; gap: 8px; flex-wrap: wrap; }
`;
