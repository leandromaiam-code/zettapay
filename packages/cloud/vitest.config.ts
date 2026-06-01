import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve @zettapay/listener to its TypeScript source so the cloud test suite
// runs without first building the listener's dist/. Production resolves the
// package normally via its exports map.
const listenerSrc = fileURLToPath(new URL('../listener/src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@zettapay\/listener\/storage$/, replacement: `${listenerSrc}/storage/index.ts` },
      { find: /^@zettapay\/listener$/, replacement: `${listenerSrc}/index.ts` },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
