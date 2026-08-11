import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
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
    // Tests and the mock Tally server are not part of the stdio process.
    files: ['tests/**/*.ts', 'mock-tally/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  prettier
);
