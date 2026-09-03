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
  build: {
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const moduleId = id.replaceAll('\\', '/');
          if (!moduleId.includes('/node_modules/')) return undefined;

          // Arco stays automatic so route-only components are not pulled into the initial graph.
          if (
            moduleId.includes('/node_modules/react/') ||
            moduleId.includes('/node_modules/react-dom/') ||
            moduleId.includes('/node_modules/react-router/') ||
            moduleId.includes('/node_modules/react-router-dom/') ||
            moduleId.includes('/node_modules/scheduler/')
          ) {
            return 'vendor-react';
          }
          if (moduleId.includes('/node_modules/@tauri-apps/plugin-dialog/')) {
            return 'capability-dialog';
          }
          if (
            moduleId.includes('/node_modules/@tauri-apps/plugin-process/') ||
            moduleId.includes('/node_modules/@tauri-apps/plugin-updater/')
          ) {
            return 'capability-updater';
          }
          if (moduleId.includes('/node_modules/@tauri-apps/api/')) {
            return 'vendor-tauri-core';
          }

          return undefined;
        },
      },
    },
  },
});
