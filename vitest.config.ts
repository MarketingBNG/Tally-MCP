import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Suites run in parallel. Safe because each one starts its own mock Tally
    // on an OS-assigned port rather than a fixed one, so there is nothing to
    // race over. (The comment here used to claim the opposite of what the
    // value does; the value was right.)
    fileParallelism: true,
    globals: false,
  },
});
