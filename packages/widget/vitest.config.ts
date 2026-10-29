// Standalone on purpose: vitest picks this file over vite.config.ts, so tests don't depend on the build config.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
