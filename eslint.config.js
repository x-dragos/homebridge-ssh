import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

const NODE_BUILTINS = [
  'fs',
  'fs/*',
  'path',
  'path/*',
  'crypto',
  'os',
  'events',
  'stream',
  'stream/*',
  'util',
  'buffer',
  'timers',
  'timers/*',
  'process',
  'url',
  'querystring',
  'http',
  'https',
  'net',
  'tls',
  'dns',
  'child_process',
];
const NODE_PREFIXED = NODE_BUILTINS.map((m) => `node:${m}`);
const NODE_PREFIXED_GLOB = ['node:*', 'node:**'];

export default tseslint.config(
  {
    ignores: ['dist/**', 'docs/**', 'test/hbConfig/**', 'homebridge-ui/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      eqeqeq: ['error', 'smart'],
      curly: ['error', 'all'],
      'dot-notation': 'error',
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': ['error', { classes: false, enums: false }],
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none', argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...NODE_BUILTINS.map((name) => ({
              name,
              message: 'domain/ must not import node built-ins — use a port + adapter.',
            })),
            ...NODE_PREFIXED.map((name) => ({
              name,
              message: 'domain/ must not import node built-ins — use a port + adapter.',
            })),
          ],
          patterns: [
            {
              group: ['homebridge', 'homebridge/*'],
              message: 'domain/ must not import homebridge — use a port + adapter.',
            },
            { group: ['ssh2', 'ssh2/*'], message: 'domain/ must not import ssh2 — use the CommandRunner port.' },
            { group: NODE_PREFIXED_GLOB, message: 'domain/ must not import node:* built-ins — use a port + adapter.' },
          ],
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
);
