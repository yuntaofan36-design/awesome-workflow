import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
    host: '127.0.0.1',
    port: 4301,
    strictPort: true,
  },
  preview: { port: 4301, strictPort: true },
});
