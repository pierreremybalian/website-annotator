# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-28

First release.

### Added
- **Widget**: launcher, drag-to-select capture (selection PNG + annotated viewport JPEG), report form, success card, on-page pins with screenshot, notes, Trello comments and replies. Console-error capture, SPA navigation support, `window.Annotate` API, Alt+Shift+A shortcut.
- **Worker**: issues API backed by Trello cards, D1 and R2; signed screenshot URLs; project/access-key and Origin checks; status self-heal from Trello.
- **Connect Trello popup**: log in, pick or create a board, smart list defaults, keys sent back to the WordPress settings page automatically. The first member to connect becomes the owner.
- **Trello webhook**: list moves, archives and deletes update pin status.
- **WordPress plugin**: Settings → Annotate with Connect/Reconnect/Disconnect, role gate, client activation links, admin-bar "Report issue", early console-error catcher.
- Deploy script, plugin packaging script, unit tests and Playwright end-to-end tests.
