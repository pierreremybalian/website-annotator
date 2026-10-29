/** @jsxImportSource hono/jsx */
import type { Child } from 'hono/jsx';
import { raw } from 'hono/html';
import { css } from './styles';
import { commonJs } from './client';
import { jsonForScript } from './util';

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 28 28'%3E%3Crect width='28' height='28' rx='8' fill='%23ff4f2b'/%3E%3Cpath d='M14 6.5a5.8 5.8 0 0 0-5.8 5.8c0 4.3 5.8 9.2 5.8 9.2s5.8-4.9 5.8-9.2A5.8 5.8 0 0 0 14 6.5z' fill='%23fff'/%3E%3Ccircle cx='14' cy='12.3' r='2.1' fill='%23ff4f2b'/%3E%3C/svg%3E";

export const BrandMark = () => (
  <svg width="26" height="26" viewBox="0 0 28 28" aria-hidden="true">
    <rect width="28" height="28" rx="8" fill="#ff4f2b" />
    <path d="M14 6.5a5.8 5.8 0 0 0-5.8 5.8c0 4.3 5.8 9.2 5.8 9.2s5.8-4.9 5.8-9.2A5.8 5.8 0 0 0 14 6.5z" fill="#fff" />
    <circle cx="14" cy="12.3" r="2.1" fill="#ff4f2b" />
  </svg>
);

export const TrelloMark = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2" y="2" width="20" height="20" rx="4.5" fill="#fff" />
    <rect x="5.5" y="5.5" width="5.5" height="12" rx="1.3" fill="#0c66e4" />
    <rect x="13" y="5.5" width="5.5" height="7.5" rx="1.3" fill="#0c66e4" />
  </svg>
);

export const CheckIcon = () => (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

export const AlertIcon = () => (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5M12 16.5v.01" />
  </svg>
);

export const PlusIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const LinkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
  </svg>
);

/** Page data for the inline script. Not executed, so it needs no nonce. */
export const Data = (props: { value: unknown }) => (
  <script type="application/json" id="cfg" dangerouslySetInnerHTML={{ __html: jsonForScript(props.value) }} />
);

export const Script = (props: { nonce: string; js: string }) => <script nonce={props.nonce} dangerouslySetInnerHTML={{ __html: props.js }} />;

const Steps = (props: { current: number }) => (
  <div class="steps" role="img" aria-label={`Step ${props.current} of 3`}>
    {[1, 2, 3].map((i) => (
      <i class={i <= props.current ? 'on' : ''} />
    ))}
  </div>
);

export const Layout = (props: { title: string; nonce: string; step?: number; children?: Child }) => (
  <>
    {raw('<!doctype html>')}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>{`${props.title} · Annotate`}</title>
        <link rel="icon" href={FAVICON} />
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        <div class="shell">
          <header class="top">
            <div class="brand">
              <BrandMark />
              Annotate
            </div>
            {props.step ? <Steps current={props.step} /> : null}
          </header>
          {props.children}
        </div>
        <Script nonce={props.nonce} js={commonJs} />
      </body>
    </html>
  </>
);

/** Content-Security-Policy for connect pages: only our nonce'd inline scripts, same-origin fetches. */
export const pageCsp = (nonce: string) =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
