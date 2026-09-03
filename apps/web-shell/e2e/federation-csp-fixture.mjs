import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../control-plane/dist');
const manifest = await readFile(join(root, 'mf-manifest.json'));
const digest = createHash('sha256').update(manifest).digest('hex');
const hits = { allowed: [], blocked: [] };

await Promise.all([listen(4391, 'allowed', true), listen(4392, 'blocked', false)]);
console.log(`Federation CSP fixture ready; manifest sha256=${digest}`);

function listen(port, name, serveRemote) {
  return new Promise((resolveListen, reject) => {
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      hits[name].push(url.pathname);
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'no-store');
      if (url.pathname === '/__digest') {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(digest);
        return;
      }
      if (url.pathname === '/__hits') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(hits[name]));
        return;
      }
      if (!serveRemote) {
        response
          .writeHead(200, { 'content-type': 'text/javascript' })
          .end('globalThis.__blockedFederationScriptExecuted = true;');
        return;
      }
      try {
        const prefix = `/objects/${digest}/`;
        const relativePath = url.pathname.startsWith(prefix)
          ? url.pathname.slice(prefix.length)
          : url.pathname.replace(/^\//, '');
        const requested = normalize(join(root, relativePath || 'index.html'));
        const child = relative(root, requested);
        if (child.startsWith('..') || isAbsolute(child)) {
          response.writeHead(403).end();
          return;
        }
        const bytes = await readFile(requested);
        response.writeHead(200, { 'content-type': mediaType(requested), 'content-length': bytes.length });
        response.end(bytes);
      } catch {
        response.writeHead(404).end();
      }
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolveListen(server));
  });
}

function mediaType(path) {
  return (
    {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
    }[extname(path)] ?? 'application/octet-stream'
  );
}
