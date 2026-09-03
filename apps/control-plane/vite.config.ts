import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import { defineConfig } from 'vite';

const crossOriginRemoteHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
};

function controlPlaneVendorChunk(id: string): string | undefined {
  const moduleId = id.replaceAll('\\', '/');
  if (!moduleId.includes('/node_modules/')) return undefined;

  // React and react-dom stay under Module Federation's singleton ownership.
  if (moduleId.includes('/@tanstack/')) return 'vendor-query';
  if (moduleId.includes('/react-router-dom/') || moduleId.includes('/react-router/')) {
    return 'vendor-router';
  }
  if (moduleId.includes('/i18next/')) return 'vendor-i18n';
  if (moduleId.includes('/zod/')) return 'vendor-schema';
  return undefined;
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    federation({
      name: 'awesome_control_plane',
      filename: 'remoteEntry.js',
      exposes: {
        './app': './src/remote.tsx',
      },
      manifest: true,
      shared: {
        react: { singleton: true },
        'react-dom': { singleton: true },
      },
    }),
  ],
  build: {
    cssCodeSplit: true,
    rollupOptions: {
      output: { manualChunks: controlPlaneVendorChunk },
    },
    target: 'es2022',
  },
  server: {
    cors: true,
    headers: crossOriginRemoteHeaders,
    host: '0.0.0.0',
    port: 4302,
    strictPort: true,
  },
  preview: { headers: crossOriginRemoteHeaders, port: 4302, strictPort: true },
});
