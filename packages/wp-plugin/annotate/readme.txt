=== Annotate – Website Feedback ===
Contributors: baliandesign
Tags: feedback, bug report, trello, annotation, screenshot
Requires at least: 5.7
Tested up to: 7.1
Requires PHP: 8.0
Stable tag: 0.2.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Let your team and clients report website issues straight to Trello.

== Description ==

Annotate adds a feedback button to your site. Click it, drag a box over the problem, add a note, and a Trello card is created with a screenshot, the page URL and browser details. Earlier reports show up as pins on the page, with their status and comments from Trello.

* Logged-in users with the chosen role see the button on every page, with their name and email filled in.
* Clients who aren't logged in can be given a private access link. Opening it once turns on feedback mode in their browser.
* Regular visitors never download the widget.
* Each report records which post, template and block it came from, so a developer or coding agent can find the code to fix: the page context (post ID, post type, template file relative to the theme, slug, theme), plus the name of the block the reporter clicked (for example `core/group` or `acf/hero`).

Built by Pierre Balian — https://balian.dev
Source and issues: https://github.com/pierreremybalian/website-annotator

== Installation ==

1. Upload the `annotate` folder to `/wp-content/plugins/` and activate it.
2. Go to Settings → Annotate and click "Connect Trello".
3. Log in to Trello in the popup and pick a board. That's it.

For local development, set the endpoint under Settings → Annotate → Advanced (e.g. `http://localhost:8787`), or define `ANNOTATE_DEFAULT_ENDPOINT` in `wp-config.php`.

== Frequently Asked Questions ==

= What happens when I disconnect? =

The keys are removed from this site and the widget stops loading. Your Trello board and cards are untouched.

= Does it slow down my site for visitors? =

No. Visitors get a few hundred bytes of inline script that checks for an access link. The widget itself is only downloaded by people who use it.

= What does it add to my pages' HTML? =

On pages where the widget can be used, it adds a small inline script that sets `window.AnnotateContext` (post ID, post type, template path relative to the theme, slug, whether it's the front page, and the theme), and a `data-annotate-block="core/paragraph"` attribute on each block. With access links off, this happens only for logged-in users with the chosen role. It's never added in wp-admin, REST responses, feeds or embeds.

= Does it expose file paths or other private data? =

No server paths are output. The template is given relative to the theme folder (for example `page-templates/landing.php`), and blocks are identified by their registered name only. Developers can add fields with the `annotate_page_context` filter, or turn off the block attributes with `add_filter( 'annotate_block_hints', '__return_false' );`.

== Changelog ==

= 0.2.0 =
* Click an element to report it (hover highlight, arrow keys to adjust, Shift+drag for an area). Pins follow the element at every screen size.
* "Issues on this page" panel.
* "Ready for review" status: confirm a fix (Looks good) or reopen it (Still broken) right on the pin.
* Page context (post, template, theme) and block names are sent with each report, so coding agents can find the right file.

= 0.1.0 =
* First release.
