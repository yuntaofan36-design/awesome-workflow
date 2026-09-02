import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    open: true,
    port: 4300,
    proxy: {
      '/api': {
        changeOrigin: true,
        target: 'http://localhost:4100',
      },
    },
    strictPort: true,
  },
  preview: { port: 4300, strictPort: true },
});
