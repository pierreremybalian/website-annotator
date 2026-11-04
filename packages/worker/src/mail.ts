// Outgoing email: login links and invites. Resend in production (MAIL_PROVIDER=resend); everywhere else the
// mail is kept in memory, for tests and /dev/mail.

import type { Env } from './env';
import { DAY, hit } from './rate-limit';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export class MailError extends Error {}

const outbox: Mail[] = [];

/** Dev/test helper: the mail "sent" without a provider, oldest first. */
export const sentMail = (): readonly Mail[] => outbox;
export const resetMail = () => void outbox.splice(0);

async function resend(env: Env, m: Mail) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) }),
  });
  if (!res.ok) throw new MailError(`Resend → ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** Send one email, within the Worker-wide daily cap. Throws MailError when it can't go out. */
export async function sendMail(env: Env, m: Mail): Promise<void> {
  if (!(await hit(env, 'mail:day', Number(env.MAIL_DAILY_CAP) || 90, DAY))) throw new MailError('daily email limit reached');
  if (env.MAIL_PROVIDER === 'resend') {
    if (!env.RESEND_API_KEY || !env.MAIL_FROM) throw new MailError('RESEND_API_KEY and MAIL_FROM must be set');
    await resend(env, m);
  } else outbox.push(m);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** A short, plain email with one button. `lines` are paragraphs of text. */
export function simpleHtml(lines: string[], button: { label: string; url: string }, footer: string): string {
  const p = (t: string) => `<p style="margin:0 0 16px;font:16px/1.5 -apple-system,Segoe UI,sans-serif;color:#1c1b1a">${esc(t)}</p>`;
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f5f3">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:28px">
${lines.map(p).join('\n')}
<p style="margin:8px 0 24px"><a href="${esc(button.url)}" style="display:inline-block;background:#ff4f2b;color:#fff;text-decoration:none;font:600 15px -apple-system,Segoe UI,sans-serif;padding:12px 20px;border-radius:10px">${esc(button.label)}</a></p>
<p style="margin:0;font:13px/1.5 -apple-system,Segoe UI,sans-serif;color:#77726c">${esc(footer)}</p>
</div></body></html>`;
}
