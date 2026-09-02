import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  envPrefix: ['VITE_', 'OUTPUT_TARGET'],
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 4303,
    strictPort: true,
    open: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
