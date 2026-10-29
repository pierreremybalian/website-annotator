// Shared CSS for everything inside the widget's shadow root. App injects BASE_CSS once;
// components may add their own <style> blocks but should use these variables.
export const BASE_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.annotate-root {
  --an-accent: #ff4f2b;
  --an-accent-ink: #ffffff;
  --an-ink: #16181d;
  --an-muted: #6b7280;
  --an-surface: #ffffff;
  --an-surface-2: #f4f5f7;
  --an-border: #e3e5e8;
  --an-status-new: #ff4f2b;
  --an-status-in_progress: #f5a524;
  --an-status-review: #3b82f6;
  --an-status-resolved: #17a34a;
  --an-status-archived: #9ca3af;
  --an-radius: 10px;
  --an-shadow: 0 10px 30px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.12);
  --an-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --an-z: 2147483000;
  font-family: var(--an-font);
  font-size: 14px;
  line-height: 1.4;
  color: var(--an-ink);
}
`;
