import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPlatformConfig } from '@awesome-workflow/config';

import { createApiApplication } from './bootstrap.js';

const TEST_PASSWORD = 'correct-horse-battery-staple';

test('administrator password login issues the existing HttpOnly session with platform admin role', async (context) => {
  const app = await createApiApplication(
    loadPlatformConfig({
      NODE_ENV: 'test',
      REPOSITORY_MODE: 'memory',
      AUTH_PASSWORD_ADMIN_EMAIL: 'Admin@Example.Test',
      AUTH_PASSWORD_ADMIN_PASSWORD: TEST_PASSWORD,
      SESSION_SECRET: 'test-session-secret-that-is-at-least-32-characters',
      OTP_PEPPER: 'test-otp-pepper-that-is-at-least-32-characters',
      WORKER_CALLBACK_TOKEN: 'test-worker-token-that-is-at-least-32-characters',
    }),
  );
  context.after(() => app.close());
  const server = app.getHttpAdapter().getInstance();

  const providersResponse = await server.inject({ method: 'GET', url: '/api/v1/auth/providers' });
  assert.equal(providersResponse.statusCode, 200, providersResponse.body);
  const passwordProvider = providersResponse
    .json()
    .data.find((provider: { id: string }) => provider.id === 'password');
  assert.deepEqual(passwordProvider, {
    id: 'password',
    label: 'Administrator account',
    labelKey: 'auth.provider.password',
    protocol: 'password',
    status: 'active',
    strategy: 'local_password',
  });

  const rejected = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/password/login',
    payload: { email: 'admin@example.test', password: 'wrong-password' },
  });
  assert.equal(rejected.statusCode, 401, rejected.body);
  assert.equal(rejected.json().code, 'invalid_credentials');

  const login = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/password/login',
    payload: { email: 'ADMIN@example.test', password: TEST_PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.json().data.email, 'admin@example.test');
  assert.deepEqual(login.json().data.platformRoles, ['platform_admin']);
  const cookie = String(login.headers['set-cookie']);
  assert.match(cookie, /aw_session=/);
  assert.match(cookie, /HttpOnly/i);

  const session = await server.inject({
    method: 'GET',
    url: '/api/v1/auth/session',
    headers: { cookie: cookie.split(';', 1)[0]! },
  });
  assert.equal(session.statusCode, 200, session.body);
  assert.equal(session.json().data.email, 'admin@example.test');
});

test('password login stays disabled unless the administrator credentials are configured as a pair', async (context) => {
  assert.throws(() =>
    loadPlatformConfig({
      NODE_ENV: 'test',
      AUTH_PASSWORD_ADMIN_EMAIL: 'admin@example.test',
    }),
  );

  const app = await createApiApplication(loadPlatformConfig({ NODE_ENV: 'test' }));
  context.after(() => app.close());
  const response = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: '/api/v1/auth/password/login',
      payload: { email: 'admin@example.test', password: TEST_PASSWORD },
    });
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(response.json().code, 'password_auth_disabled');
});
