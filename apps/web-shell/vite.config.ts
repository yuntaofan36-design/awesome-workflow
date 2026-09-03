import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';

import { createShellCsp } from './src/runtime/shellCsp';

const FEDERATION_POLICY_PATH = '/.well-known/awesome-workflow/federation-policy';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const webPort = readPort(env.VITE_WEB_PORT, 4300);
  const trustedFederationOrigins = readOrigins(env.VITE_TRUSTED_FEDERATION_ORIGINS);
  if (mode === 'development' && trustedFederationOrigins.length === 0) {
    trustedFederationOrigins.push('http://localhost:4302');
  }
  const apiOrigin = absoluteOrigin(env.VITE_API_BASE_URL);
  const frameOrigin = absoluteOrigin(env.VITE_DEMO_IFRAME_URL);
  const csp = createShellCsp({
    allowViteReactRefresh: mode === 'development',
    apiOrigins: apiOrigin ? [apiOrigin] : [],
    frameOrigins: frameOrigin ? [frameOrigin] : mode === 'development' ? ['http://127.0.0.1:4301'] : [],
    trustedFederationOrigins,
    webPort,
  });
  const securityHeaders = {
    'Content-Security-Policy': csp,
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
  };

  return {
    plugins: [federationPolicyEndpoint(trustedFederationOrigins), react(), tailwindcss()],
    server: {
      headers: securityHeaders,
      host: '0.0.0.0',
      open: true,
      port: webPort,
      proxy: {
        '/api': {
          changeOrigin: true,
          target: 'http://localhost:4100',
        },
      },
      strictPort: true,
    },
    preview: { headers: securityHeaders, port: webPort, strictPort: true },
  };
});

function federationPolicyEndpoint(origins: readonly string[]): Plugin {
  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const pathname = new URL(request.url ?? '/', 'http://vite.local').pathname;
    if (pathname !== FEDERATION_POLICY_PATH) {
      next();
      return;
    }
    response.statusCode = 200;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.end(origins.join('\n'));
  };
  return {
    name: 'awesome-workflow-federation-policy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

function readOrigins(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(/[\s,]+/)
        .map(absoluteOrigin)
        .filter(isPresent),
    ),
  ];
}

function absoluteOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function readPort(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}
