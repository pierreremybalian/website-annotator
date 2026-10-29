// Fixture for @annotate/astro. FIXTURE_MODE=always switches to the always-on (staging) setup,
// FIXTURE_SOURCE_ATTRS=1 turns on sourceAttributes, FIXTURE_ENDPOINT overrides the Worker URL,
// FIXTURE_CSP=1 turns on Astro's security.csp.
import { defineConfig } from 'astro/config';
import annotate from '../src/index.ts';

const always = process.env.FIXTURE_MODE === 'always';

export default defineConfig({
  security: process.env.FIXTURE_CSP === '1' ? { csp: true } : undefined,
  integrations: [
    annotate({
      project: 'pk_fixture_project',
      endpoint: process.env.FIXTURE_ENDPOINT || 'http://localhost:8787',
      mode: always ? 'always' : 'activation',
      accessKey: 'ak_fixture_secret',
      enabled: true,
      sourceAttributes: process.env.FIXTURE_SOURCE_ATTRS === '1',
      context: { site: 'fixture' },
    }),
  ],
});
