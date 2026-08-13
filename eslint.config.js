import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // `release/` holds assembled release folders, each containing a full copy of
    // dist/ and node_modules/. Without this, linting the repo after a packaging
    // run tries to typecheck built output that no tsconfig covers.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'release/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Explicit project rather than projectService: tests/, mock-tally/ and
        // the root config files sit outside the build tsconfig's `include`,
        // and the service refuses to type-check files it cannot place.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // This server speaks MCP over stdio: stdout IS the protocol channel.
      // Anything written there corrupts the transport, so console is banned
      // outright — use the logger in src/utils/logger.ts, which writes to stderr.
      'no-console': 'error',
    },
  },
  {
    /**
     * TypeScript diagnostic scripts. These run from a terminal against a live
     * TallyPrime, so a human reads their output directly — `console` is the
     * interface, not a mistake. They are written in TypeScript rather than
     * plain ESM (unlike the installer scripts) so they can reuse the real
     * request builders and client, which is the whole point: a probe that
     * constructs its own request bodies would not be testing what production
     * sends.
     */
    files: ['scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Tests and the mock Tally server are not part of the stdio process.
    files: ['tests/**/*.ts', 'mock-tally/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      // The setup helpers are plain ESM with no declarations, so anything a
      // test imports from them arrives as `any`. Asserting on it is the point.
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    /**
     * Plain-JavaScript tooling: the installer scripts and the repo's own
     * release/dev scripts.
     *
     * Deliberately not TypeScript. The installer scripts run from the bundled
     * Node runtime inside the shipped folder, where there is no build step and
     * no node_modules; the repo scripts run before a build exists. That means no
     * type information, so the type-aware rules are switched off here rather
     * than fought with — and `console` is the whole point of these files, since
     * they talk to a human through a terminal window rather than over MCP stdio.
     */
    files: ['installer/**/*.mjs', 'scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { project: null },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        structuredClone: 'readonly',
        // Node 18+ built-ins. The live probes talk to TallyPrime over HTTP and have
        // to decode UTF-16LE responses, so they need both.
        fetch: 'readonly',
        TextDecoder: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  prettier
);
