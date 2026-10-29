=== Annotate – Website Feedback ===
Contributors: baliandesign
Tags: feedback, bug report, trello, annotation, screenshot
Requires at least: 5.7
Tested up to: 7.1
Requires PHP: 8.0
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Let your team and clients report website issues straight to Trello.

== Description ==

Annotate adds a feedback button to your site. Click it, drag a box over the problem, add a note, and a Trello card is created with a screenshot, the page URL and browser details. Earlier reports show up as pins on the page, with their status and comments from Trello.

* Logged-in users with the chosen role see the button on every page, with their name and email filled in.
* Clients who aren't logged in can be given a private access link. Opening it once turns on feedback mode in their browser.
* Regular visitors never download the widget.

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

== Changelog ==

= 0.1.0 =
* First release.
