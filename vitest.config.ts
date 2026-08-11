import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The mock Tally server binds a port; keep suites that use it from racing.
    fileParallelism: true,
    globals: false,
  },
});
