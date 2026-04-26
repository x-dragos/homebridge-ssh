import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/domain/**', 'src/adapters/**'],
      // Homebridge-side accessory glue and the SSH connection pool are thin
      // wiring around already-tested domain orchestrators / runner; covering
      // them meaningfully would require a substantial Homebridge mock harness.
      // Keep the high-coverage requirement on the domain layer where the logic
      // actually lives.
      exclude: [
        'src/index.ts',
        'src/settings.ts',
        'src/platform.ts',
        'src/adapters/homebridge/**',
        'src/adapters/ssh/ssh-connection-pool.ts',
      ],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 90,
        functions: 95,
        statements: 90,
        branches: 80,
      },
    },
  },
});
