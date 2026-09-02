import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';

import { loadPlatformConfig } from '@awesome-workflow/config';
import { DESKTOP_OFFLINE_SCOPE, DESKTOP_PUBLIC_CLIENT_ID } from '@awesome-workflow/contracts';
import { exportJWK, SignJWT } from 'jose';

import { createApiApplication } from './bootstrap.js';

const SESSION_SECRET = 'test-session-secret-that-is-at-least-32-characters';
const OTP_PEPPER = 'test-otp-pepper-that-is-at-least-32-characters';
const WORKER_TOKEN = 'test-worker-token-that-is-at-least-32-characters';

test('CLI browser authorization uses exact loopback PKCE and rejects code replay', async (context) => {
  const app = await createApiApplication(
    loadPlatformConfig({
      NODE_ENV: 'test',
      REPOSITORY_MODE: 'memory',
      AUTH_MODE: 'local_otp',
      AUTH_DEV_EXPOSE_OTP: 'true',
      SESSION_SECRET,
      OTP_PEPPER,
      WORKER_CALLBACK_TOKEN: WORKER_TOKEN,
      API_PUBLIC_URL: 'http://localhost:4100',
      WEB_PUBLIC_URL: 'http://localhost:4300',
    }),
  );
  context.after(() => app.close());
  const server = app.getHttpAdapter().getInstance();
  const cookie = await login(server, 'cli-user@example.test');
  const verifier = 'v'.repeat(64);
  const codeChallenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const redirectUri = 'http://127.0.0.1:54321/callback';
  const state = 's'.repeat(48);

  const authorization = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/cli/authorize',
    payload: { redirectUri, codeChallenge, codeChallengeMethod: 'S256', state },
  });
  assert.equal(authorization.statusCode, 200, authorization.body);
  const loginContinuation = new URL(authorization.json().data.authorizationUrl);
  assert.equal(loginContinuation.origin, 'http://localhost:4300');
  const requestId = loginContinuation.searchParams.get('cliRequestId');
  assert.match(requestId ?? '', /^[0-9a-f-]{36}$/i);

  const approval = await server.inject({
    method: 'GET',
    url: `/api/v1/auth/cli/approve?requestId=${encodeURIComponent(requestId!)}`,
    cookies: { aw_session: cookie },
  });
  assert.equal(approval.statusCode, 302, approval.body);
  const callback = new URL(String(approval.headers.location));
  assert.equal(callback.origin, 'http://127.0.0.1:54321');
  assert.equal(callback.pathname, '/callback');
  assert.equal(callback.searchParams.get('state'), state);
  const code = callback.searchParams.get('code');
  assert.ok(code);

  const token = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/cli/token',
    payload: { code, codeVerifier: verifier, redirectUri },
  });
  assert.equal(token.statusCode, 200, token.body);
  const session = token.json().data as {
    accessToken: string;
    expiresAt: string;
    tokenType: string;
    user: { email: string };
  };
  assert.equal(session.user.email, 'cli-user@example.test');
  assert.equal(session.tokenType, 'Bearer');
  assert.equal('refreshToken' in session, false);
  assert.ok(new Date(session.expiresAt).getTime() - Date.now() <= 60 * 60 * 1000);

  const bearerSession = await server.inject({
    method: 'GET',
    url: '/api/v1/auth/session',
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  assert.equal(bearerSession.statusCode, 200);

  const bearerLogout = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  assert.equal(bearerLogout.statusCode, 204);

  const revokedBearerSession = await server.inject({
    method: 'GET',
    url: '/api/v1/auth/session',
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  assert.equal(revokedBearerSession.statusCode, 401);

  const replay = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/cli/token',
    payload: { code, codeVerifier: verifier, redirectUri },
  });
  assert.equal(replay.statusCode, 409);

  const unsafeRedirect = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/cli/authorize',
    payload: {
      redirectUri: 'https://attacker.example.test/callback',
      codeChallenge,
      codeChallengeMethod: 'S256',
      state,
    },
  });
  assert.equal(unsafeRedirect.statusCode, 400);
});

test('desktop offline refresh rotates tokens, detects replay, and logout revokes the family', async (context) => {
  const app = await createApiApplication(
    loadPlatformConfig({
      NODE_ENV: 'test',
      REPOSITORY_MODE: 'memory',
      AUTH_MODE: 'local_otp',
      AUTH_DEV_EXPOSE_OTP: 'true',
      SESSION_SECRET,
      OTP_PEPPER,
      WORKER_CALLBACK_TOKEN: WORKER_TOKEN,
      API_PUBLIC_URL: 'http://localhost:4100',
      WEB_PUBLIC_URL: 'http://localhost:4300',
    }),
  );
  context.after(() => app.close());
  const server = app.getHttpAdapter().getInstance();
  const cookie = await login(server, 'desktop-refresh@example.test');

  const initial = await authorizeOfflineSession(server, cookie, 'v', 54322);
  assert.equal(initial.tokenType, 'Bearer');
  assert.match(initial.refreshToken, /^[A-Za-z0-9_-]{64}$/);

  const rotatedResponse = await refresh(server, initial.refreshToken);
  assert.equal(rotatedResponse.statusCode, 200, rotatedResponse.body);
  assert.match(String(rotatedResponse.headers['cache-control']), /no-store/);
  const rotated = rotatedResponse.json() as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
  };
  assert.equal(rotated.token_type, 'Bearer');
  assert.equal(rotated.expires_in, 3600);
  assert.notEqual(rotated.access_token, initial.accessToken);
  assert.notEqual(rotated.refresh_token, initial.refreshToken);

  assert.equal(await sessionStatus(server, initial.accessToken), 401);
  assert.equal(await sessionStatus(server, rotated.access_token), 200);

  const replay = await refresh(server, initial.refreshToken);
  assert.equal(replay.statusCode, 400, replay.body);
  assert.equal(replay.json().code, 'invalid_grant');
  assert.equal(await sessionStatus(server, rotated.access_token), 401);
  const revokedNextRefresh = await refresh(server, rotated.refresh_token);
  assert.equal(revokedNextRefresh.statusCode, 400, revokedNextRefresh.body);

  const logoutFamily = await authorizeOfflineSession(server, cookie, 'w', 54323);
  const logout = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { authorization: `Bearer ${logoutFamily.accessToken}` },
  });
  assert.equal(logout.statusCode, 204, logout.body);
  const refreshAfterLogout = await refresh(server, logoutFamily.refreshToken);
  assert.equal(refreshAfterLogout.statusCode, 400, refreshAfterLogout.body);
});

test('workload exchange verifies configured issuer, audience, subject and JWKS', async (context) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = await exportJWK(publicKey);
  const jwksServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' });
    response.end(
      JSON.stringify({ keys: [{ ...publicJwk, alg: 'RS256', use: 'sig', kid: 'workload-test' }] }),
    );
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  context.after(() => {
    jwksServer.closeAllConnections();
    return new Promise<void>((resolve, reject) =>
      jwksServer.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = jwksServer.address();
  assert.ok(address && typeof address === 'object');
  const issuer = 'https://issuer.example.test';
  const audience = 'awesome-workflow';
  const subject = 'repo:example/awesome-workflow:environment:release';
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'workload-test', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  const app = await createApiApplication(
    loadPlatformConfig({
      NODE_ENV: 'test',
      REPOSITORY_MODE: 'memory',
      AUTH_MODE: 'local_otp',
      SESSION_SECRET,
      OTP_PEPPER,
      WORKER_CALLBACK_TOKEN: WORKER_TOKEN,
      WORKLOAD_OIDC_POLICIES: JSON.stringify([
        {
          issuer,
          audience,
          jwksUri: `http://127.0.0.1:${address.port}/jwks.json`,
          subject,
          principalEmail: 'release-ci@workload.example.test',
          displayName: 'Release CI',
        },
      ]),
    }),
  );
  context.after(() => app.close());
  const server = app.getHttpAdapter().getInstance();
  const exchanged = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/workload/exchange',
    payload: {
      subjectToken: jwt,
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
    },
  });
  assert.equal(exchanged.statusCode, 200, exchanged.body);
  assert.equal(exchanged.json().data.user.email, 'release-ci@workload.example.test');

  const wrongAudience = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'workload-test', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience('wrong-audience')
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  const rejected = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/workload/exchange',
    payload: {
      subjectToken: wrongAudience,
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
    },
  });
  assert.equal(rejected.statusCode, 401);
});

async function login(
  server: { inject(options: Record<string, unknown>): Promise<any> },
  email: string,
): Promise<string> {
  const challenge = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/email/challenges',
    payload: { email },
  });
  assert.equal(challenge.statusCode, 200, challenge.body);
  const result = challenge.json().data as { challengeId: string; devCode: string };
  const verified = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/email/verify',
    payload: { challengeId: result.challengeId, code: result.devCode },
  });
  assert.equal(verified.statusCode, 200, verified.body);
  const cookie = verified.cookies.find((candidate: { name: string }) => candidate.name === 'aw_session');
  assert.ok(cookie?.value);
  return cookie.value as string;
}

async function authorizeOfflineSession(
  server: { inject(options: Record<string, unknown>): Promise<any> },
  cookie: string,
  verifierCharacter: string,
  port: number,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string; tokenType: string }> {
  const verifier = verifierCharacter.repeat(64);
  const codeChallenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authorization = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/cli/authorize',
    payload: {
      redirectUri,
      codeChallenge,
      codeChallengeMethod: 'S256',
      scope: DESKTOP_OFFLINE_SCOPE,
      state: verifierCharacter.repeat(48),
    },
  });
  assert.equal(authorization.statusCode, 200, authorization.body);
  const requestId = new URL(authorization.json().data.authorizationUrl).searchParams.get('cliRequestId');
  assert.ok(requestId);
  const approval = await server.inject({
    method: 'GET',
    url: `/api/v1/auth/cli/approve?requestId=${encodeURIComponent(requestId)}`,
    cookies: { aw_session: cookie },
  });
  assert.equal(approval.statusCode, 302, approval.body);
  const code = new URL(String(approval.headers.location)).searchParams.get('code');
  assert.ok(code);
  const exchange = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/cli/token',
    payload: { code, codeVerifier: verifier, redirectUri },
  });
  assert.equal(exchange.statusCode, 200, exchange.body);
  return exchange.json().data;
}

function refresh(server: { inject(options: Record<string, unknown>): Promise<any> }, refreshToken: string) {
  return server.inject({
    method: 'POST',
    url: '/api/v1/auth/cli/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: DESKTOP_PUBLIC_CLIENT_ID,
    }).toString(),
  });
}

async function sessionStatus(
  server: { inject(options: Record<string, unknown>): Promise<any> },
  accessToken: string,
): Promise<number> {
  const response = await server.inject({
    method: 'GET',
    url: '/api/v1/auth/session',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return response.statusCode;
}
