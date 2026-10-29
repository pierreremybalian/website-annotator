// Styles for the connect popup (~520×720). Inlined into every page; no external assets.

export const css = /* css */ `
:root {
  --accent: #ff4f2b;
  --accent-hover: #ea3d19;
  --accent-soft: rgba(255, 79, 43, 0.12);
  --trello: #0c66e4;
  --trello-hover: #0055cc;
  --bg: #f7f6f4;
  --surface: #ffffff;
  --text: #1c1b1a;
  --muted: #6b6965;
  --border: #e5e2dd;
  --border-strong: #cfcbc4;
  --danger: #c4320a;
  --danger-soft: #fff1ec;
  --code-bg: #f1efeb;
  --radius: 12px;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161514;
    --surface: #201f1d;
    --text: #f2f0ed;
    --muted: #a19d97;
    --border: #34322f;
    --border-strong: #4a4743;
    --danger: #ff8a6b;
    --danger-soft: #3a1f17;
    --code-bg: #2a2826;
    --accent-soft: rgba(255, 79, 43, 0.18);
  }
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; }
[hidden] { display: none !important; }

.shell {
  max-width: 480px;
  min-height: 100%;
  margin: 0 auto;
  padding: 24px 24px 0;
  display: flex;
  flex-direction: column;
}
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.brand { display: flex; align-items: center; gap: 9px; font-weight: 650; letter-spacing: -0.01em; }
.brand svg { display: block; }
.steps { display: flex; gap: 5px; }
.steps i { width: 22px; height: 4px; border-radius: 2px; background: var(--border); }
.steps i.on { background: var(--accent); }

main { flex: 1; padding: 28px 0 24px; }
main > .fields { margin: 0 0 16px; }
h1 { font-size: 23px; line-height: 1.25; letter-spacing: -0.02em; margin: 0 0 8px; font-weight: 700; }
.lead { color: var(--muted); margin: 0 0 20px; }
.fine { color: var(--muted); font-size: 13px; margin: 14px 0 0; }
.center { text-align: center; }

.chip {
  display: inline-flex; align-items: center; gap: 6px;
  margin: 0 0 22px; padding: 4px 10px 4px 8px;
  border: 1px solid var(--border); border-radius: 999px;
  background: var(--surface); color: var(--muted); font-size: 13px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chip b { color: var(--text); font-weight: 600; }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 10px;
  width: 100%; min-height: 48px; padding: 0 18px;
  border: 0; border-radius: 10px;
  font: inherit; font-weight: 600; text-decoration: none; cursor: pointer;
  transition: background-color .15s, opacity .15s, transform .05s;
}
.btn:active:not(:disabled) { transform: translateY(1px); }
.btn:focus-visible, .row:has(input:focus-visible), select:focus-visible, input:focus-visible, .ghost:focus-visible {
  outline: 3px solid var(--accent-soft); outline-offset: 1px;
}
.btn:disabled { opacity: .45; cursor: default; }
.btn-trello { background: var(--trello); color: #fff; }
.btn-trello:hover { background: var(--trello-hover); }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn-quiet { background: transparent; color: var(--muted); border: 1px solid var(--border); min-height: 42px; }
.btn-quiet:hover { color: var(--text); border-color: var(--border-strong); }
.ghost {
  border: 1px solid var(--border); background: var(--surface); color: var(--text);
  border-radius: 8px; padding: 5px 10px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
}
.ghost:hover { border-color: var(--border-strong); }

/* Board picker */
.filter {
  width: 100%; margin: 0 0 10px; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface); color: var(--text); font: inherit;
}
.rows { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; border: 0; }
.row {
  position: relative; display: flex; align-items: center; gap: 12px;
  padding: 11px 14px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); cursor: pointer; transition: border-color .15s, box-shadow .15s;
}
.row:hover { border-color: var(--border-strong); }
.row input { position: absolute; opacity: 0; pointer-events: none; }
.row .name { flex: 1; min-width: 0; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .sub { display: block; color: var(--muted); font-size: 13px; font-weight: 400; white-space: normal; }
.tile {
  flex: none; width: 34px; height: 34px; border-radius: 8px;
  display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 14px;
}
.dot { flex: none; width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--border-strong); transition: border .15s; }
.row.selected, .row:has(input:checked) { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.row.selected .dot, .row:has(input:checked) .dot { border: 6px solid var(--accent); }
.row.create { border: 1.5px dashed var(--accent); color: var(--accent); background: transparent; font: inherit; text-align: left; width: 100%; }
.row.create .tile { background: var(--accent-soft); color: var(--accent); }
.row.create .name { color: var(--accent); }
.row.create:hover { background: var(--accent-soft); }
.row.create:disabled { cursor: default; opacity: .7; }
/* CLI mode: the link-a-project and new-board sections */
.section { margin: 0 0 28px; }
.rows ~ .section, .empty ~ .section { margin: 28px 0 0; }
.section-title { font-size: 16px; line-height: 1.3; font-weight: 650; letter-spacing: -0.01em; margin: 0 0 4px; }
.section .section-title { margin-bottom: 12px; }
.section-sub { color: var(--muted); font-size: 14px; margin: 0 0 14px; }
.row.project { cursor: default; }
.row.project:hover { border-color: var(--border); }
.link-btn {
  flex: none; min-height: 34px; padding: 0 14px; border-radius: 8px;
  border: 1px solid var(--accent); background: transparent; color: var(--accent);
  font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; transition: background-color .15s, color .15s;
}
.link-btn:hover:not(:disabled) { background: var(--accent); color: #fff; }
.link-btn:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 1px; }
.link-btn:disabled { opacity: .45; cursor: default; }
.section-label { margin: 18px 0 8px; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.empty { color: var(--muted); font-size: 14px; padding: 6px 2px; }

footer.bar {
  position: sticky; bottom: 0;
  margin: 0 -24px; padding: 14px 24px 20px;
  background: var(--bg); border-top: 1px solid var(--border);
}
.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
.field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.field.wide { grid-column: 1 / -1; }
.field span { font-size: 12.5px; color: var(--muted); font-weight: 550; }
select, input[type="url"], input[type="text"] {
  width: 100%; min-width: 0; height: 38px; padding: 0 10px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--surface); color: var(--text); font: inherit; font-size: 14px;
}
.hint { font-size: 13px; color: var(--muted); margin: 0 0 12px; }
.msg { margin: 0 0 12px; padding: 10px 12px; border-radius: 10px; background: var(--danger-soft); color: var(--danger); font-size: 14px; }

/* Result & status */
.badge {
  width: 64px; height: 64px; margin: 24px auto 18px; border-radius: 50%;
  display: grid; place-items: center; background: var(--accent-soft); color: var(--accent);
}
.badge.err { background: var(--danger-soft); color: var(--danger); }
.badge.pop { animation: pop .35s cubic-bezier(.2, 1.4, .4, 1); }
@keyframes pop { from { transform: scale(.6); opacity: 0; } }
.spinner {
  width: 36px; height: 36px; margin: 48px auto 18px; border-radius: 50%;
  border: 3px solid var(--border); border-top-color: var(--accent); animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.copy-block { margin: 0 0 18px; }
.copy-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.copy-head b { font-size: 14px; }
pre.code {
  margin: 0; padding: 12px; border-radius: 10px; background: var(--code-bg); border: 1px solid var(--border);
  font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap; word-break: break-all;
}
.actions { display: flex; flex-direction: column; gap: 10px; margin-top: 22px; }
`;
