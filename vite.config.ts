import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const fromEnv = process.env.CAMPAIGNER_BASE?.trim();
  const base =
    fromEnv && fromEnv.length > 0
      ? fromEnv.endsWith('/')
        ? fromEnv
        : `${fromEnv}/`
      : mode === 'domainfactory'
        ? '/Campaigner/'
        : '/';

  return {
    base,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    worker: {
      format: 'es',
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['tests/setup.ts'],
      include: ['tests/**/*.test.{ts,tsx}'],
      css: false,
      // jsdom + PDF/image suites are memory-heavy; unbounded workers caused
      // event-loop starvation and false 5s timeouts on constrained CI/dev VMs.
      maxWorkers: 4,
      testTimeout: 20_000,
    },
  };
});
