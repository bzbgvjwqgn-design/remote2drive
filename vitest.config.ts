import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Worker and reconciler code logs through pino; tests assert on state, not
    // on log lines, so keep the output readable.
    env: {
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
    },
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
