import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';

import { AuthSessionResultSchema, type AuthSessionResult } from '@awesome-workflow/contracts';

import { ApiClient, ApiHttpError, type FetchLike } from './api-client.js';
import { saveCredential } from './credentials.js';
import { CliError, SecretRedactor, isRecord, requireEnvironmentSecret } from './safety.js';

export type PkcePair = { verifier: string; challenge: string };

export function createPkcePair(random: (size: number) => Buffer = randomBytes): PkcePair {
  const verifier = random(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

export function createLoginState(random: (size: number) => Buffer = randomBytes): string {
  return random(32).toString('base64url');
}

export function assertCallbackState(expected: string, received: string | null): void {
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const receivedDigest = createHash('sha256')
    .update(received ?? '', 'utf8')
    .digest();
  if (!received || received.length !== expected.length || !timingSafeEqual(expectedDigest, receivedDigest)) {
    throw new CliError('Login callback state did not match; the authorization response was rejected.');
  }
}

export async function interactiveLogin(options: {
  apiBaseUrl: string;
  fetchImpl?: FetchLike;
  environment?: NodeJS.ProcessEnv;
  configDir?: string;
  timeoutMs?: number;
  openBrowser?: (url: string) => Promise<void>;
  redactor?: SecretRedactor;
}): Promise<AuthSessionResult> {
  const redactor = options.redactor ?? new SecretRedactor();
  const api = new ApiClient(options.apiBaseUrl, undefined, options.fetchImpl, redactor);
  const pkce = createPkcePair();
  redactor.add(pkce.verifier);
  const state = createLoginState();
  redactor.add(state);
  const receiver = await startLoopbackReceiver(state, options.timeoutMs ?? 120_000);
  try {
    const authorizationUrl = await requestCliAuthorization(api, {
      redirectUri: receiver.redirectUri,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: 'S256',
      state,
    });
    await (options.openBrowser ?? openSystemBrowser)(authorizationUrl);
    const code = await receiver.code;
    redactor.add(code);
    const session = await exchangeCliCode(api, {
      code,
      codeVerifier: pkce.verifier,
      redirectUri: receiver.redirectUri,
    });
    redactor.add(session.accessToken);
    await saveCredential(
      { apiBaseUrl: api.baseUrl, accessToken: session.accessToken, expiresAt: session.expiresAt },
      { environment: options.environment, configDir: options.configDir },
    );
    return session;
  } finally {
    await receiver.close();
  }
}

export async function workloadLogin(options: {
  apiBaseUrl: string;
  environment: NodeJS.ProcessEnv;
  oidcEnvironmentName: string;
  fetchImpl?: FetchLike;
  configDir?: string;
  redactor?: SecretRedactor;
}): Promise<AuthSessionResult> {
  const redactor = options.redactor ?? new SecretRedactor();
  const subjectToken = requireEnvironmentSecret(options.oidcEnvironmentName, options.environment, redactor);
  const api = new ApiClient(options.apiBaseUrl, undefined, options.fetchImpl, redactor);
  let value: unknown;
  try {
    value = await api.request<unknown>('POST', '/auth/workload/exchange', {
      subjectToken,
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
    });
  } catch (error) {
    if (error instanceof ApiHttpError && error.status === 404) {
      throw new CliError(
        'Server does not support workload authentication. Required endpoint: /api/v1/auth/workload/exchange.',
      );
    }
    throw error;
  }
  const session = parseSession(value);
  redactor.add(session.accessToken);
  await saveCredential(
    { apiBaseUrl: api.baseUrl, accessToken: session.accessToken, expiresAt: session.expiresAt },
    { environment: options.environment, configDir: options.configDir },
  );
  return session;
}

type LoopbackReceiver = {
  redirectUri: string;
  code: Promise<string>;
  close: () => Promise<void>;
};

export async function startLoopbackReceiver(
  expectedState: string,
  timeoutMs: number,
): Promise<LoopbackReceiver> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  let settled = false;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // A preflight authorization failure can close the listener before callers
  // begin awaiting the callback. Attach a handler now so that rejection never
  // becomes an unhandled process-level event; the original promise still
  // rejects for callers awaiting `code`.
  void code.catch(() => undefined);
  const settle = (result: { code: string } | { error: Error }): void => {
    if (settled) return;
    settled = true;
    if ('code' in result) resolveCode(result.code);
    else rejectCode(result.error);
  };

  const server = createServer((request, response) => {
    try {
      const target = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method !== 'GET' || target.pathname !== '/callback') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      assertCallbackState(expectedState, target.searchParams.get('state'));
      const authorizationCode = target.searchParams.get('code');
      if (!authorizationCode) throw new CliError('Login callback did not include an authorization code.');
      response
        .writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        .end('Awesome Workflow login completed. You can close this window.');
      settle({ code: authorizationCode });
    } catch (error) {
      response
        .writeHead(400, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        .end('Authorization response rejected. Return to the terminal.');
      settle({ error: error instanceof Error ? error : new CliError('Authorization response rejected.') });
    }
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await listenOnLoopback(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new CliError('Unable to allocate a loopback callback port.');
  }
  const timer = setTimeout(
    () => settle({ error: new CliError('Timed out waiting for the login callback.') }),
    timeoutMs,
  );
  timer.unref();

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    code,
    close: async () => {
      clearTimeout(timer);
      if (!settled) settle({ error: new CliError('Login callback listener closed.') });
      await closeServer(server);
    },
  };
}

async function requestCliAuthorization(
  api: ApiClient,
  input: { redirectUri: string; codeChallenge: string; codeChallengeMethod: 'S256'; state: string },
): Promise<string> {
  let value: unknown;
  try {
    value = await api.request<unknown>('POST', '/auth/cli/authorize', input);
  } catch (error) {
    if (error instanceof ApiHttpError && error.status === 404) {
      throw new CliError(
        'Server does not support interactive CLI authentication. Required endpoints: /api/v1/auth/cli/authorize and /api/v1/auth/cli/token; the browser cookie flow is intentionally not reused.',
      );
    }
    throw error;
  }
  if (!isRecord(value) || typeof value.authorizationUrl !== 'string') {
    throw new CliError('CLI authorization endpoint returned an invalid response.');
  }
  const url = new URL(value.authorizationUrl);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new CliError('CLI authorization URL must use HTTP(S).');
  return url.toString();
}

async function exchangeCliCode(
  api: ApiClient,
  input: { code: string; codeVerifier: string; redirectUri: string },
): Promise<AuthSessionResult> {
  try {
    return parseSession(await api.request<unknown>('POST', '/auth/cli/token', input));
  } catch (error) {
    if (error instanceof ApiHttpError && error.status === 404) {
      throw new CliError(
        'Server does not support CLI token exchange. Required endpoint: /api/v1/auth/cli/token.',
      );
    }
    throw error;
  }
}

function parseSession(value: unknown): AuthSessionResult {
  const parsed = AuthSessionResultSchema.safeParse(value);
  if (!parsed.success) throw new CliError('Authentication endpoint returned an invalid short-lived session.');
  const expiry = new Date(parsed.data.expiresAt).getTime();
  const lifetime = expiry - Date.now();
  if (lifetime <= 30_000 || lifetime > 24 * 60 * 60 * 1_000) {
    throw new CliError(
      'Authentication endpoint did not return a short-lived CLI session (maximum lifetime is 24 hours).',
    );
  }
  return parsed.data;
}

async function openSystemBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, shell: false, stdio: 'ignore', windowsHide: true });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', () =>
      reject(
        new CliError(
          'Unable to open the system browser. Open the authorization URL manually using a trusted terminal.',
        ),
      ),
    );
  });
}

async function listenOnLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
