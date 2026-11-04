import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // A spare database for migration tests (test/migration.test.ts), which apply migrations step by step.
          d1Databases: { MIGRATION_DB: 'migration-test' },
          bindings: {
            TEST_MIGRATIONS: migrations,
            TRELLO_MOCK: '1',
            PUBLIC_URL: 'http://localhost:8787',
            TRELLO_KEY: 'mock-key',
            TRELLO_SECRET: 'mock-secret',
            TOKEN_ENC_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            SIGNING_SECRET: 'test-signing-secret',
            MAIL_PROVIDER: 'log',
            MAIL_DAILY_CAP: '100000',
            SIGNUP_MODE: 'closed',
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/apply-migrations.ts'] },
  };
});
