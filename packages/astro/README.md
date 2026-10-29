# @annotate/astro

Astro integration for Annotate. It injects the feedback widget, sets `window.AnnotateContext`, and records which component rendered each element, so an agent running `annotate show` can open the right file.

By [Pierre Balian](https://balian.dev) · [GitHub](https://github.com/pierreremybalian/website-annotator)

## Install

It isn't on npm yet. Link it from a checkout of this repo:

```bash
pnpm add -D link:../website-annotations/packages/astro
```

npm: `npm i -D ../website-annotations/packages/astro`. Inside this monorepo, use `"@annotate/astro": "workspace:*"`. You can also import the source directly in `astro.config.mjs`: `import annotate from '../website-annotations/packages/astro/src/index.ts'`. The package ships TypeScript source, which Astro's config loader compiles. It needs `astro` ≥ 4 (tested with 7.4).

## Get a project key

Use the CLI from this repo (`packages/cli`). You don't need WordPress:

```bash
annotate connect --site https://staging.example.com
```

It opens the Trello popup and saves `.annotate.json` (gitignored). It prints the project key (`pk_…`), the access key (`ak_…`) and an activation link (`https://example.com/?annotate=ak_…`). To link a repo to an existing project, use `annotate init`. The project key is public: it ends up in your HTML. The access key turns on feedback mode, so share it only through activation links, or on staging builds.

## Configure

**Production (activation links).** Regular visitors download nothing. Anyone who opens `https://example.com/?annotate=<access key>` gets the widget in that browser until they turn it off.

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import annotate from '@annotate/astro';

export default defineConfig({
  integrations: [annotate({ project: 'pk_…' })],
});
```

**Staging/preview (always on).** Everyone who can reach the site sees the widget, with no link needed. Gate it on the environment, so production gets the activation loader:

```js
const staging = process.env.PUBLIC_STAGE === 'staging';

export default defineConfig({
  integrations: [
    annotate({
      project: 'pk_…',
      mode: staging ? 'always' : 'activation',
      accessKey: process.env.ANNOTATE_ACCESS_KEY, // used only in 'always' mode
      enabled: true, // explicit, since the mode is already gated (silences the always-mode warning)
    }),
  ],
});
```

To have no widget on production at all, use `mode: 'always', enabled: staging`.

`astro.config.mjs` is evaluated before Vite loads `.env`, so `import.meta.env.X` is empty there for your own variables. Use `process.env` (set by the shell or CI) or Vite's `loadEnv`. The integration does read the `ANNOTATE_*` variables below from both `process.env` and the project's `.env`, `.env.local`, `.env.<mode>` and `.env.<mode>.local` files, so `annotate()` with no project works if `PUBLIC_ANNOTATE_PROJECT` is in `.env`.

### Options

| Option | Default | |
|---|---|---|
| `project` | `PUBLIC_ANNOTATE_PROJECT`, then `ANNOTATE_PROJECT` | Project key `pk_…`. Required unless `enabled: false`; the build fails with a clear error if it's missing. |
| `endpoint` | `PUBLIC_ANNOTATE_ENDPOINT` / `ANNOTATE_ENDPOINT`, then `https://annotate.pierre-51f.workers.dev` | Worker URL. |
| `mode` | `'activation'` | `'activation'`: inline loader, widget only for activated browsers. `'always'`: widget for everyone (staging). |
| `accessKey` | `ANNOTATE_ACCESS_KEY` / `PUBLIC_ANNOTATE_ACCESS_KEY` | Required by `'always'`, and it then appears in the HTML. Ignored in `'activation'`, so it never reaches the page. |
| `enabled` | `true` | `false` injects nothing. Always mode logs a warning unless you set this explicitly. |
| `position` | `'bottom-right'` | Or `'bottom-left'`. |
| `context` | `{}` | Extra fields merged into `window.AnnotateContext`, e.g. `{ stage: 'staging', commit: process.env.COMMIT_REF }`. Must be JSON and under 4 KB in total. |
| `sourceManifest` | `true` | Write `.annotate/astro-cids.json` on every `astro build`, even when `enabled` is false. |
| `sourceAttributes` | `false` | Staging only. Adds `data-annotate-source="src/components/X.astro"` to each component's root element. |

## What it injects

One classic `head-inline` script (Astro renders it as `<script>…</script>` in `<head>`):

- **Activation mode**: if the URL has `?annotate=` or `localStorage` has `annotate:access:<project>`, it sets `window.AnnotateContext`, installs the error catcher and appends `<script src="<endpoint>/widget.js" data-endpoint data-project data-position async>`. Otherwise it does nothing else. It's the same loader the WordPress plugin gives visitors, and it never contains the access key.
- **Always mode**: the error catcher, `window.AnnotateContext`, then `widget.js` with `data-access` and `data-always-on="true"`.

The error catcher follows the WP plugin's contract: `window.__annotateErrors` holds the last 20 entries `{ kind, message, stack?, at }` from `error`, `unhandledrejection` and `console.error`.

`window.AnnotateContext` is `{ platform: 'astro', astro: '<astro version>', base: '<config.base>', ...context }`. The widget sends it with each report.

**CSP.** The script has no inline handlers and no eval, and it's identical on every page, so Astro's `security.csp` hashes it like its own scripts. When `security.csp` is on, the integration adds the endpoint's origin to `scriptDirective.resources`, keeping `'self'` (otherwise widget.js would be blocked). If a proxy adds a nonce to the loader, the loader copies it to widget.js. Known limit: the widget styles its Shadow DOM with a `<style>` element, which a hash-only `style-src` (what Astro's CSP emits) blocks. The widget loads but renders unstyled.

## View transitions (`<ClientRouter />`)

The widget mounts on `<html>`, outside `<body>`, so Astro's swap leaves it alone. The inline script is identical on every page, so the router never re-runs it, and a guard means widget.js is only ever loaded once per document. The widget follows `pushState` navigations itself and refreshes its pins for the new URL. The loader also re-checks on `astro:after-swap`, in case an activation link is reached by client-side navigation. This was checked in Chromium against the fixture in both modes: one widget, one widget.js request, across navigations.

## Source hints

The widget reads these attributes from the picked element and its ancestors, nearest first, and the CLI resolves them to files.

**`astro dev`: `data-astro-source-file` + `data-astro-source-loc`.** Astro's compiler adds these to every HTML element in a component's template (not `<html>`) when the dev toolbar is enabled. That's the default; it's off if `devToolbar.enabled` is false or the toolbar is disabled in your preferences. The file is an absolute path on your machine, e.g. `/Users/you/site/src/components/Hero.astro`. The loc is `line:column`; with Astro 7's Rust compiler, the column points just past the opening tag's `>`. Nothing extra is needed in dev, and they never appear in `astro build`.

**`astro build`: `data-astro-cid-<hash>`.** A component with a scoped `<style>` gets one 8-character hash. It's derived from the file's path relative to the project root (`/src/components/Hero.astro`), not from its contents. So it's the same in dev, CI and every local build, and it changes only when the file moves. Every element in that component's own template gets the attribute (`<html>` and `<body>` included, but not `<head>`, `<title>`, `<script>` or `<style>`). Components without scoped styles get none. With `scopedStyleStrategy: 'class'` or `'where'`, Astro writes `class="astro-<hash>"` instead, which the widget doesn't read. Keep the default `'attribute'`.

**The manifest.** During `astro build`, a Vite plugin sees each `.astro` module right after Astro compiles it, takes the hash from the generated template code, and maps it to the module's path. At `astro:build:done` it writes:

```
<project root>/.annotate/astro-cids.json
{ "ge2uvauf": "src/components/Hero.astro", "hkbrpulz": "src/layouts/Base.astro", … }
```

It's written to the project directory, never to `dist`, so it isn't deployed. It also writes `.annotate/.gitignore` containing `*`, so git ignores the folder without changes to your own `.gitignore`. The CLI reads the file from disk, so being ignored doesn't hide it. The issue was reported on staging, but the hashes depend only on paths, so a local `astro build` produces the same map: run one before `annotate show` if the manifest is missing or stale. The manifest is replaced on each build.

**`sourceAttributes: true`** (opt-in, staging). Before compiling, it adds `data-annotate-source="<path>"` to the first element of each component in your project (not `node_modules`). This covers components without scoped styles. It skips templates that start with a component, an expression, a `<slot>` or `<html>`, and it doesn't overwrite an attribute you set yourself. Line numbers don't move. It puts source paths in public HTML, so tie it to `enabled` on staging only.

**By hand.** Any element can carry `data-annotate-source="src/components/Thing.astro"` (or a component name). It takes priority over the other hints.

## Development

```bash
pnpm --filter @annotate/astro test
pnpm --filter @annotate/astro typecheck
cd packages/astro && ./node_modules/.bin/astro build --root fixture
```

`fixture/` is a two-page site with a layout, components with scoped styles and a `<ClientRouter />`. It imports the integration from `../src/index.ts`. Set `FIXTURE_MODE=always`, `FIXTURE_SOURCE_ATTRS=1`, `FIXTURE_CSP=1` or `FIXTURE_ENDPOINT=<url>` to try the variants. Its `dist/`, `.astro/` and `.annotate/` are gitignored.
