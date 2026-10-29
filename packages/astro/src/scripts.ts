// The inline <head> scripts the integration injects (injectScript('head-inline', …)).
//
// They are classic, synchronous scripts with no inline event handlers or eval, so Astro's `security.csp`
// hashes them like any other head-inline script; a nonce on the loader (set by a proxy) is copied to widget.js.
// Contents are identical on every page, so Astro's ClientRouter never re-runs them after a swap.

import type { PageContext } from '@annotate/shared';
import { MAX_CONTEXT_BYTES, type ResolvedOptions } from './options.ts';

/**
 * JSON safe to embed in an inline <script>: <, >, &, ' and U+2028/9 are \u-escaped, so a value can never
 * close the script tag or break out of a string. Same idea as the WP plugin's JSON_HEX_* flags.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/'/g, '\\u0027')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Early error catcher: fills window.__annotateErrors (last 20) from window "error", "unhandledrejection" and
 * console.error (the original console.error still runs). Copied from the WP plugin (Annotate_Frontend::catcher_js)
 * so both adapters share one contract: entries { kind, message, stack?, at }.
 */
export const CATCHER_JS = `(function(w){
	if (w.__annotateErrors) return;
	var buf = w.__annotateErrors = [];
	function str(v){
		try {
			if (typeof v === 'string') return v;
			if (v instanceof Error) return v.message;
			var s = JSON.stringify(v);
			return s === undefined ? String(v) : s;
		} catch (e) {
			try { return String(v); } catch (e2) { return ''; }
		}
	}
	function push(kind, message, stack){
		try {
			var entry = { kind: kind, message: String(message || '').slice(0, 2000), at: Date.now() };
			if (stack) entry.stack = String(stack).slice(0, 4000);
			buf.push(entry);
			if (buf.length > 20) buf.splice(0, buf.length - 20);
		} catch (e) {}
	}
	w.addEventListener('error', function(ev){
		var err = ev.error;
		push('error', ev.message || (err && err.message) || 'Script error', err && err.stack);
	});
	w.addEventListener('unhandledrejection', function(ev){
		var r = ev.reason;
		push('unhandledrejection', r && r.message ? r.message : str(r), r && r.stack);
	});
	var c = w.console, orig = c && c.error;
	if (typeof orig === 'function') {
		c.error = function(){
			try {
				var parts = [], stack;
				for (var i = 0; i < arguments.length; i++) {
					var a = arguments[i];
					if (!stack && a instanceof Error) stack = a.stack;
					parts.push(str(a));
				}
				push('console.error', parts.join(' '), stack);
			} catch (e) {}
			return orig.apply(this, arguments);
		};
	}
})(window);`;

export interface PageContextInput {
  astroVersion: string;
  base: string;
  context?: Record<string, unknown>;
}

/** window.AnnotateContext for Astro: { platform: 'astro', astro, base, ...context }. Throws if over 4 KB as JSON. */
export function buildPageContext({ astroVersion, base, context }: PageContextInput): PageContext {
  const ctx: PageContext = { platform: 'astro', astro: astroVersion, base, ...(context ?? {}) };
  const size = new TextEncoder().encode(JSON.stringify(ctx)).length;
  if (size > MAX_CONTEXT_BYTES) {
    throw new Error(`[@annotate/astro] window.AnnotateContext is ${size} bytes as JSON; the limit is ${MAX_CONTEXT_BYTES}. Trim \`context\`.`);
  }
  return ctx;
}

/**
 * Activation mode (production-safe). Regular visitors run only the check: no catcher, no context, no download.
 * The widget loads when the URL has ?annotate= or this browser stored an access key for the project
 * (`annotate:access:<project>`, written by the widget). Same contract as the WP plugin's visitor loader.
 * The access key is never part of this script.
 */
export function activationScript(opts: Pick<ResolvedOptions, 'project' | 'endpoint' | 'position'>, ctx: PageContext): string {
  return `(function(w, d){
	var project = ${jsonForScript(opts.project)};
	var cur = d.currentScript, nonce = cur && cur.nonce;
	function load(){
		if (w.__annotateLoader || d.querySelector('annotate-widget')) return;
		var on = /[?&]annotate=/.test(w.location.search);
		if (!on) {
			try { on = !!w.localStorage.getItem('annotate:access:' + project); } catch (e) {}
		}
		if (!on) return;
		w.__annotateLoader = 1;
		w.AnnotateContext = ${jsonForScript(ctx)};
		${CATCHER_JS}
		var s = d.createElement('script');
		if (nonce) s.nonce = nonce;
		s.src = ${jsonForScript(`${opts.endpoint}/widget.js`)};
		s.async = true;
		s.setAttribute('data-endpoint', ${jsonForScript(opts.endpoint)});
		s.setAttribute('data-project', project);
		s.setAttribute('data-position', ${jsonForScript(opts.position)});
		(d.head || d.documentElement).appendChild(s);
	}
	load();
	// ClientRouter: this script isn't re-run after a swap, so re-check in case the new URL has ?annotate=.
	// Once mounted, the widget lives on <html> and survives swaps, so it's never loaded twice.
	d.addEventListener('astro:after-swap', load);
})(window, document);`;
}

/**
 * Always-on mode (staging/preview): catcher, context, then widget.js with data-access + data-always-on.
 * Guarded so a re-run (or a second copy of the script) never adds a second widget.
 */
export function alwaysOnScript(
  opts: Pick<ResolvedOptions, 'project' | 'endpoint' | 'position'> & { accessKey: string },
  ctx: PageContext,
): string {
  return `${CATCHER_JS}
(function(w, d){
	w.AnnotateContext = ${jsonForScript(ctx)};
	if (w.__annotateLoader || d.querySelector('annotate-widget')) return;
	w.__annotateLoader = 1;
	var cur = d.currentScript, s = d.createElement('script');
	if (cur && cur.nonce) s.nonce = cur.nonce;
	s.src = ${jsonForScript(`${opts.endpoint}/widget.js`)};
	s.async = true;
	s.setAttribute('data-endpoint', ${jsonForScript(opts.endpoint)});
	s.setAttribute('data-project', ${jsonForScript(opts.project)});
	s.setAttribute('data-access', ${jsonForScript(opts.accessKey)});
	s.setAttribute('data-always-on', 'true');
	s.setAttribute('data-position', ${jsonForScript(opts.position)});
	(d.head || d.documentElement).appendChild(s);
})(window, document);`;
}

/** The head-inline scripts for resolved options, in order. Empty when disabled. */
export function buildHeadScripts(opts: ResolvedOptions, ctx: PageContext): string[] {
  if (!opts.enabled) return [];
  if (opts.mode === 'always') {
    if (!opts.accessKey) throw new Error('[@annotate/astro] always mode without an access key');
    return [alwaysOnScript({ ...opts, accessKey: opts.accessKey }, ctx)];
  }
  return [activationScript(opts, ctx)];
}
