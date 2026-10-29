import type { Env } from './env';
import type { ProjectRow } from './db';
import { trello, type Trello } from './trello';

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(env: Env) {
  return crypto.subtle.importKey('raw', unb64(env.TOKEN_ENC_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypt a Trello token for storage. Format: base64(iv).base64(ciphertext) */
export async function encryptToken(env: Env, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(token));
  return `${b64(iv)}.${b64(ct)}`;
}

export async function decryptToken(env: Env, enc: string): Promise<string> {
  const [iv, ct] = enc.split('.');
  if (!iv || !ct) throw new Error('malformed encrypted token');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct));
  return new TextDecoder().decode(pt);
}

/** Trello client authenticated as the member who connected this project. */
export async function trelloForProject(env: Env, project: Pick<ProjectRow, 'trello_token_enc'>): Promise<Trello> {
  return trello(env, await decryptToken(env, project.trello_token_enc));
}

/** base64 HMAC. */
export async function hmac(algo: 'SHA-1' | 'SHA-256', secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: algo }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
