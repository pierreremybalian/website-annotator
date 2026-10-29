# @annotate/widget

The feedback button that runs on client sites. One self-contained script (`widget.js`, ~120 KB gzipped) that renders inside a Shadow DOM, so it can't clash with the site's CSS.

**What it does**
- Floating launcher → **Report an issue** → **click an element** (hover highlights it) → form (title, notes, name/email) → Trello card. **Shift+drag** (or "Draw area") draws a free box instead. A box that mostly covers one element snaps to it.
- Captures two images with [snapdom](https://github.com/zumerlab/snapdom): the picked element or area (PNG) and the full viewport with it outlined (JPEG). Fixed and sticky elements appear where the user saw them.
- Records page URL, browser, OS, viewport, scroll position, the last 20 console errors, and **context for coding agents**: the element's HTML (trimmed, form values stripped), selector, nearest landmark, key styles, **source hints**, and the page context set by the platform adapter.
- **Pins**: numbered markers on the reported element, colored by status. The outline always matches the element's current size. Click one for the screenshot, notes and comments, and to reply. Issues "Ready for review" show **Looks good ✓ / Still broken**.
- **Issues on this page** panel: every issue for the page, including ones whose element isn't visible at the current screen size ("reported at 1440px").

## Embedding

```html
<script src="https://annotate.pierre-51f.workers.dev/widget.js"
        data-endpoint="https://annotate.pierre-51f.workers.dev"
        data-project="pk_…"
        defer></script>
```

On WordPress, the plugin outputs this for you.

| Attribute | |
|---|---|
| `data-endpoint` | Worker base URL (required) |
| `data-project` | Project key `pk_…` (required) |
| `data-access` | Access key `ak_…`. With `data-always-on`, the widget is active without an activation link |
| `data-always-on` | Active immediately when present; `"false"` turns it off |
| `data-reporter-name`, `data-reporter-email` | Prefill the reporter |
| `data-position` | `bottom-right` (default) or `bottom-left` |

## Activation

The widget renders nothing unless one of these is true, so a public site's visitors never see it:

1. `data-always-on` and `data-access` are set. The WP plugin does this for logged-in users with the chosen role.
2. The URL contains `?annotate=<access key>`. The key is saved to `localStorage` (`annotate:access:<project>`) and removed from the address bar. The person keeps feedback mode until they choose **Turn off feedback mode** in the menu.
3. A key was saved earlier.

## Controls

- **Alt+Shift+A** starts a report. While picking, **↑/↓** or the scroll wheel move to the parent or child element, **Shift+drag** draws an area, and **Esc** cancels. **Cmd/Ctrl+Enter** sends.
- `window.Annotate.open()` and `window.Annotate.showPins(true|false)` drive it from other code. The WP admin bar's **Report issue** uses these.
- The reporter's name and email are remembered in `localStorage` (`annotate:reporter`).

## Layout

```
src/index.ts              bootstrap: config, activation, mounts <annotate-widget>
src/api.ts                Worker client
src/capture/screenshot.ts snapdom capture → selection PNG + context JPEG
src/capture/anchor.ts     createElementAnchor / createAnchor / resolveAnchor (where a pin goes)
src/capture/context.ts    element HTML, landmark, styles, source hints, page context
src/capture/env.ts        browser/OS/viewport + console-error buffer
src/ui/App.tsx            state machine: idle → selecting → capturing → form → submitted
src/ui/Selector.tsx       element picker (hover, ↑/↓) + Shift+drag area mode with snapping
src/ui/Form.tsx           report form + success card
src/ui/Pins.tsx           pin layer; PinPopover.tsx (details, replies, confirm/reopen); IssuePanel.tsx
dev/index.html            demo page (fixed header, cross-origin images, iframe, source-hint attributes)
```

**Anchoring**: an element pick stores a stable CSS selector (generated, Tailwind and WordPress state classes are ignored) and the element's text. The pin outlines the element's live rect, so it stays correct across resizes. If the element exists but isn't visible at this size, the pin is hidden and the issue appears only in the panel. If the element is missing or its text changed, the pin falls back to the original page coordinates and shows a dashed outline. Area reports (and pre-0.2 reports) are stored as fractions of the smallest element containing the box.

**Source hints** are read from the element and its ancestors, nearest first. They let `annotate show` point an agent at the right file:

| Attribute | Set by |
|---|---|
| `data-annotate-source="src/components/Hero.astro"` | anyone (by hand, or an adapter) |
| `data-annotate-block="acf/hero"` | WordPress plugin (block names only) |
| `data-astro-source-file` / `-loc` | Astro dev server |
| `data-astro-cid-<hash>` | Astro production; mapped to files by `@annotate/astro` |

The page context comes from `window.AnnotateContext`, a plain object of at most 4 KB.

## Commands

```bash
pnpm --filter @annotate/widget dev        # demo page on :5173 (needs the Worker on :8787)
pnpm --filter @annotate/widget build      # dist/widget.js, copied to packages/worker/public/
pnpm --filter @annotate/widget test       # anchor + pins tests (happy-dom)
```

## Known limits

DOM-rendered screenshots aren't pixel-perfect. Iframes such as YouTube embeds and maps render as placeholders. Cross-origin images served without CORS headers render as grey boxes. If capture fails entirely, the report can still be sent without a screenshot.
