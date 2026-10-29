// Signed, expiring screenshot URLs. <img> can't send the access-key headers, so the URL itself
// carries the authorization: sig = base64url(HMAC-SHA256(SIGNING_SECRET, key + '.' + exp)).

import type { Env } from './env';
import { hmac, safeEqual } from './crypto';

const b64url = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sign(env: Pick<Env, 'SIGNING_SECRET'>, key: string, exp: number): Promise<string> {
  return hmac('SHA-256', env.SIGNING_SECRET, `${key}.${exp}`).then(b64url);
}

/** Absolute URL for an R2 screenshot key, valid for ttlSec seconds. */
export async function signedScreenshotUrl(env: Pick<Env, 'SIGNING_SECRET' | 'PUBLIC_URL'>, key: string, ttlSec = 3600): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = await sign(env, key, exp);
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `${env.PUBLIC_URL.replace(/\/+$/, '')}/v1/screenshots/${path}?exp=${exp}&sig=${sig}`;
}

/** True when sig is a valid signature for key/exp and exp hasn't passed. */
export async function verifyScreenshotSignature(
  env: Pick<Env, 'SIGNING_SECRET'>,
  key: string,
  exp: string | undefined,
  sig: string | undefined,
): Promise<boolean> {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  const expNum = Number(exp);
  if (expNum < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(sig, await sign(env, key, expNum));
}
