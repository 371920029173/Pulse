/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Build config for the UI, plus the test environment.
 *
 * The `test` block was added when UI tests were introduced; the rest is
 * unchanged. `css` is on in tests because a lot of this UI is display logic, so
 * testing with stylesheets stripped would test something other than what ships.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5578,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5577',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    css: true,
  },
});
