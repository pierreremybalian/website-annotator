export interface Env {
  DB: D1Database;
  SCREENSHOTS: R2Bucket;
  ASSETS: Fetcher;
  PUBLIC_URL: string;
  /** The Worker's previous public URL, if it moved: Trello webhooks registered there still sign with it. */
  LEGACY_PUBLIC_URL?: string;
  ALLOWED_TRELLO_ORG: string;
  TRELLO_MOCK: string;
  TRELLO_KEY: string;
  TRELLO_SECRET: string;
  /** base64-encoded 32-byte AES-GCM key */
  TOKEN_ENC_KEY: string;
  /** HMAC key for signed screenshot URLs, and for login codes */
  SIGNING_SECRET: string;
  /** 'resend' sends login emails through Resend; anything else keeps them in memory (dev, tests: /dev/mail). */
  MAIL_PROVIDER?: string;
  /** e.g. "Annotate <login@annotate.balian.dev>" */
  MAIL_FROM?: string;
  RESEND_API_KEY?: string;
  /** Emails per day across the Worker (Resend's free tier allows 100). Default 90. */
  MAIL_DAILY_CAP?: string;
  /** 'open' = anyone can log in and create an org; anything else = only people already invited. */
  SIGNUP_MODE?: string;
}

export type AppEnv = { Bindings: Env; Variables: { project: ProjectRow; user: UserRow } };

import type { ProjectRow, UserRow } from './db';
