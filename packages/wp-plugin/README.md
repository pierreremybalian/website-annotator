# Annotate – WordPress plugin

Adds Annotate to a WordPress site: a **Connect Trello** button in the settings and automatic widget injection. The plugin itself lives in [`annotate/`](annotate/); `annotate/readme.txt` is the WordPress.org-format readme.

By [Pierre Balian](https://balian.dev) · [GitHub](https://github.com/pierreremybalian/website-annotator)

## Install

```bash
scripts/package-plugin.sh      # → dist/annotate-<version>.zip
```

Then go to **Plugins → Add New → Upload Plugin**, upload the zip and activate it.

## Set up

**Settings → Annotate → Connect Trello**: log in to Trello in the popup, pick a board (or have one created), click Connect. The keys are saved automatically.

Settings:
- **Who sees the widget**: Administrators, Editors and above, Contributors and above (default), or any logged-in user.
- **Access links**: when on, visitors who aren't logged in get feedback mode by opening the activation link shown on the page (`/?annotate=<access key>`). Send it to clients.
- **Position**: bottom-right or bottom-left.
- **Advanced → Endpoint**: Worker URL. The default is set by `ANNOTATE_DEFAULT_ENDPOINT` and can be overridden in `wp-config.php`, e.g. `define( 'ANNOTATE_DEFAULT_ENDPOINT', 'http://localhost:8787' );`.

## What it outputs

On the frontend (never in wp-admin, the login page, REST, feeds or embeds):

- **Users with the chosen role**: an early console-error catcher in `<head>`, then `widget.js` with their name and email prefilled. There's also a **Report issue** item in the admin bar.
- **Everyone else, with access links on**: a few lines of inline JS that load the widget only if the URL has `?annotate=` or the browser was activated before. Regular visitors download nothing.

The script tags go through `wp_get_script_tag()` / `wp_print_inline_script_tag()`, so CSP nonce filters apply.

## Internals

| | |
|---|---|
| `annotate.php` | header, constants, bootstrap |
| `includes/functions.php` | option defaults, getters, sanitizers |
| `includes/class-annotate-settings.php` | settings page; connection status from `GET /v1/project`, cached 5 minutes |
| `includes/class-annotate-rest.php` | `POST` / `DELETE /wp-json/annotate/v1/connection` (requires `manage_options` + nonce): saves or clears the keys the popup sends |
| `includes/class-annotate-frontend.php` | head output + admin-bar node |
| `assets/admin.js` | opens the popup, receives its `postMessage` (only from the endpoint's origin), saves the keys over REST |
| `uninstall.php` | removes options (multisite-aware) |

Settings are stored in one option, `annotate_settings`. Disconnecting clears the keys on the site only; the project stays on the Worker.

## Releasing

Bump the version in three places: the `Version:` header and `ANNOTATE_VERSION` in `annotate.php`, and `Stable tag:` in `readme.txt`. Add a changelog entry to `readme.txt` and to the root [`CHANGELOG.md`](../../CHANGELOG.md), then run `scripts/package-plugin.sh`. The script refuses to build if the three versions don't match.
