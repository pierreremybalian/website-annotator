# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- **Agents close what they've verified.** `annotate claim` moves a new issue to "In progress" (an existing list like Doing, or a new one after the new list), and `annotate release` moves it back. `annotate resolve` now moves the card to Done (`resolved`) instead of "Ready for review", so the agent resolves only once the fix is live and checked on the page. Anyone can reopen from Trello. The review list and the pin's Looks good / Still broken stay for cards people move there.

### Fixed
- Screenshots no longer drift from the selection on pages with inline `<style>` blocks. The page's own CSS re-applied on top of the captured styles, so on a WordPress site a footer selection showed the area above it.

## [0.2.0] - 2026-10-29

Element picking, an agentic QA loop, and Astro support.

### Added
- **Element picking.** Hover highlights the element, ↑/↓ or the wheel adjusts it, click picks. Shift+drag draws an area, and an area that mostly covers one element snaps to it. Pins outline the element's live rect, so they stay correct when the window resizes.
- **Issues on this page** panel. It lists every issue on the page, including ones not visible at the current screen size ("reported at 1440px").
- **Context capture for coding agents**: element HTML (form values stripped), selector, landmark, key styles, source hints (`data-annotate-source`, `data-annotate-block`, Astro source/cid attributes), and the page context set by adapters (`window.AnnotateContext`).
- **Review status.** "Ready for review" is a Trello list, created on demand. On the pin, clients and the team click **Looks good ✓** (→ Done) or **Still broken** (→ New, with a note).
- **Agent API** (`/v1/agent/*`, per-project hashed agent tokens): list, detail by number, claim/release leases, comment, resolve (→ review), reopen, and allowed origins.
- **`annotate` CLI** (`packages/cli`, zero runtime deps):
  - Commands: `connect`, `init`, `issues`, `show`, `screenshot`, `claim`, `release`, `comment`, `resolve`, `reopen`, `origins`, `skill`.
  - `--json` everywhere, with meaningful exit codes.
  - `show` resolves source hints to local files (block.json, Astro manifest, paths).
- **Claude Code skill** `annotate-qa` (`annotate skill install`). The routine: list → claim → locate → fix → verify → resolve.
- **CLI hand-off.** `annotate connect` / `init` open the Trello popup and receive keys device-style. The board step can link an existing project.
- **`@annotate/astro`** integration: injects the widget (activation links by default, or always-on for staging), sets page context, and writes a build-time map of Astro component IDs to source files.
- **WordPress page context** (post, template, theme) and `data-annotate-block` block hints.

### Changed
- Connect: "Create a new board for me" adds a Ready for review list, and the board picker has a review-list dropdown.
- The widget's issue list includes `review` issues. Only resolved and archived ones are hidden.

## [0.1.0] - 2026-10-28

First release.

### Added
- **Widget**: launcher, drag-to-select capture (selection PNG + annotated viewport JPEG), report form, success card, on-page pins with screenshot, notes, Trello comments and replies. Console-error capture, SPA navigation support, `window.Annotate` API, Alt+Shift+A shortcut.
- **Worker**: issues API backed by Trello cards, D1 and R2; signed screenshot URLs; project/access-key and Origin checks; status self-heal from Trello.
- **Connect Trello popup**: log in, pick or create a board, smart list defaults, keys sent back to the WordPress settings page automatically. The first member to connect becomes the owner.
- **Trello webhook**: list moves, archives and deletes update pin status.
- **WordPress plugin**: Settings → Annotate with Connect/Reconnect/Disconnect, role gate, client activation links, admin-bar "Report issue", early console-error catcher.
- Deploy script, plugin packaging script, unit tests and Playwright end-to-end tests.
