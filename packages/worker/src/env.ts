export interface Env {
  DB: D1Database;
  SCREENSHOTS: R2Bucket;
  ASSETS: Fetcher;
  PUBLIC_URL: string;
  ALLOWED_TRELLO_ORG: string;
  TRELLO_MOCK: string;
  TRELLO_KEY: string;
  TRELLO_SECRET: string;
  /** base64-encoded 32-byte AES-GCM key */
  TOKEN_ENC_KEY: string;
  /** HMAC key for signed screenshot URLs */
  SIGNING_SECRET: string;
}

export type AppEnv = { Bindings: Env; Variables: { project: ProjectRow } };

import type { ProjectRow } from './db';
