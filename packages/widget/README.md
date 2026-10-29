# @annotate/widget

The feedback button that runs on client sites. One self-contained script (`widget.js`, ~120 KB gzipped) that renders inside a Shadow DOM, so it can't clash with the site's CSS.

**What it does**
- Floating launcher → **Report an issue** → drag a box over the page → form (title, notes, name/email) → Trello card.
- Captures two images with [snapdom](https://github.com/zumerlab/snapdom): the selected area (PNG) and the full viewport with the box drawn on it (JPEG). Fixed and sticky elements appear where the user saw them.
- Records page URL, browser, OS, viewport, scroll position and the last 20 console errors.
- **Pins**: numbered markers where earlier issues were reported, colored by Trello status. Click one for the screenshot, notes and comments, and to reply.

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

- **Alt+Shift+A** starts a report. **Esc** cancels. **Cmd/Ctrl+Enter** sends.
- `window.Annotate.open()` and `window.Annotate.showPins(true|false)` drive it from other code. The WP admin bar's **Report issue** uses these.
- The reporter's name and email are remembered in `localStorage` (`annotate:reporter`).

## Layout

```
src/index.ts              bootstrap: config, activation, mounts <annotate-widget>
src/api.ts                Worker client
src/capture/screenshot.ts snapdom capture → selection PNG + context JPEG
src/capture/anchor.ts     createAnchor / resolveAnchor (where a pin goes)
src/capture/env.ts        browser/OS/viewport + console-error buffer
src/ui/App.tsx            state machine: idle → selecting → capturing → form → submitted
src/ui/Selector.tsx       drag-to-select overlay
src/ui/Form.tsx           report form + success card
src/ui/Pins.tsx           pin layer; PinPopover.tsx for details and replies
dev/index.html            demo page (fixed header, cross-origin images, iframe)
```

**Anchoring**: a report is tied to the smallest element that fully contains the box, using a stable CSS selector (generated, Tailwind and WordPress state classes are ignored) plus the box's position inside that element. If the element is later missing or its text changed, the pin falls back to the original page coordinates and shows a dashed outline.

## Commands

```bash
pnpm --filter @annotate/widget dev        # demo page on :5173 (needs the Worker on :8787)
pnpm --filter @annotate/widget build      # dist/widget.js, copied to packages/worker/public/
pnpm --filter @annotate/widget test       # anchor + pins tests (happy-dom)
```

## Known limits

DOM-rendered screenshots aren't pixel-perfect. Iframes such as YouTube embeds and maps render as placeholders. Cross-origin images served without CORS headers render as grey boxes. If capture fails entirely, the report can still be sent without a screenshot.
