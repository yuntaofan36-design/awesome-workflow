import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPlatformConfig } from '@awesome-workflow/config';

import { createApiApplication } from './bootstrap.js';

test('hybrid auth exposes local email OTP while requiring an enabled provider for OIDC', async (context) => {
  const app = await createApiApplication(
    loadPlatformConfig({
      NODE_ENV: 'test',
      REPOSITORY_MODE: 'memory',
      AUTH_MODE: 'hybrid',
      AUTH_DEV_EXPOSE_OTP: 'true',
      SESSION_SECRET: 'test-session-secret-that-is-at-least-32-characters',
      OTP_PEPPER: 'test-otp-pepper-that-is-at-least-32-characters',
      WORKER_CALLBACK_TOKEN: 'test-worker-token-that-is-at-least-32-characters',
      API_PUBLIC_URL: 'https://workflow.example.test',
      WEB_PUBLIC_URL: 'https://workflow.example.test',
      OIDC_ISSUER: 'https://identity.example.test/oidc',
      OIDC_CLIENT_ID: 'web-client',
      OIDC_CLIENT_SECRET: 'test-client-secret',
      OIDC_REDIRECT_URI: 'https://workflow.example.test/api/v1/auth/oidc/callback',
      OIDC_ENABLED_PROVIDERS: 'google',
    }),
  );
  context.after(() => app.close());
  const server = app.getHttpAdapter().getInstance();

  const providersResponse = await server.inject({ method: 'GET', url: '/api/v1/auth/providers' });
  assert.equal(providersResponse.statusCode, 200, providersResponse.body);
  const providers = providersResponse.json().data as Array<{
    id: string;
    protocol: string;
    status: string;
    strategy: string;
  }>;
  assert.deepEqual(
    providers.map(({ id, protocol, status, strategy }) => ({ id, protocol, status, strategy })),
    [
      { id: 'email', protocol: 'email_otp', status: 'active', strategy: 'local_email_otp' },
      { id: 'google', protocol: 'oidc', status: 'active', strategy: 'oidc_broker' },
      { id: 'feishu', protocol: 'oidc', status: 'disabled', strategy: 'oidc_broker' },
      { id: 'wechat', protocol: 'oidc', status: 'disabled', strategy: 'oidc_broker' },
    ],
  );

  const challengeResponse = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/email/challenges',
    payload: { email: 'Hybrid.User@Example.Test' },
  });
  assert.equal(challengeResponse.statusCode, 200, challengeResponse.body);
  const challenge = challengeResponse.json().data as { challengeId: string; devCode: string };
  assert.match(challenge.challengeId, /^[0-9a-f-]{36}$/i);
  assert.match(challenge.devCode, /^\d{6}$/);

  const verifyResponse = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/email/verify',
    payload: { challengeId: challenge.challengeId, code: challenge.devCode },
  });
  assert.equal(verifyResponse.statusCode, 200, verifyResponse.body);
  assert.equal(verifyResponse.json().data.email, 'hybrid.user@example.test');
  assert.match(String(verifyResponse.headers['set-cookie']), /aw_session=/);
  assert.match(String(verifyResponse.headers['set-cookie']), /HttpOnly/i);

  const missingProvider = await server.inject({
    method: 'GET',
    url: '/api/v1/auth/oidc/start',
  });
  assert.equal(missingProvider.statusCode, 400, missingProvider.body);
  assert.equal(missingProvider.json().code, 'social_provider_required');

  const disabledProvider = await server.inject({
    method: 'GET',
    url: '/api/v1/auth/oidc/start?provider=feishu',
  });
  assert.equal(disabledProvider.statusCode, 404, disabledProvider.body);
  assert.equal(disabledProvider.json().code, 'social_provider_disabled');
});
