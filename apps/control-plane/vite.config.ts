import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import { defineConfig } from 'vite';

const crossOriginRemoteHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
};

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
    cssCodeSplit: false,
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
