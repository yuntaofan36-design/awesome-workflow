import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPlatformConfig } from '@awesome-workflow/config';
import type { AuthProvider } from '@awesome-workflow/contracts';

import { DomainError } from '../../core/errors.js';
import type { RefreshSessionInput } from '../../core/repository.js';
import { AuthService, EMAIL_OTP_POLICY } from './auth.service.js';

const oidcProviders: AuthProvider[] = [
  {
    id: 'email',
    label: 'Broker email',
    protocol: 'oidc',
    status: 'active',
    strategy: 'oidc_broker',
    authorizeUrl: 'https://workflow.example.test/api/v1/auth/oidc/start',
  },
  {
    id: 'google',
    label: 'Google',
    protocol: 'oidc',
    status: 'active',
    strategy: 'oidc_broker',
    authorizeUrl: 'https://workflow.example.test/api/v1/auth/oidc/start?provider=google',
  },
  {
    id: 'feishu',
    label: 'Feishu',
    protocol: 'oidc',
    status: 'disabled',
    strategy: 'oidc_broker',
  },
  {
    id: 'wechat',
    label: 'WeChat',
    protocol: 'oidc',
    status: 'disabled',
    strategy: 'oidc_broker',
  },
];

test('hybrid mode keeps BFF email OTP and delegates only social providers to OIDC', async () => {
  const service = new AuthService(
    loadPlatformConfig({
      AUTH_MODE: 'hybrid',
      API_PUBLIC_URL: 'https://workflow.example.test',
      OIDC_ISSUER: 'https://identity.example.test/oidc',
      OIDC_CLIENT_ID: 'web-client',
      OIDC_CLIENT_SECRET: 'test-client-secret',
      OIDC_REDIRECT_URI: 'https://workflow.example.test/api/v1/auth/oidc/callback',
      OIDC_ENABLED_PROVIDERS: 'google',
    }),
    {} as never,
    {} as never,
    {
      providers: () => oidcProviders,
      begin: async () => ({ authorizationUrl: 'https://identity.example.test/authorize' }),
      callback: async () => {
        throw new Error('not used');
      },
    },
    {} as never,
  );

  const providers = service.providers();
  const email = providers.find((provider) => provider.id === 'email');
  assert.equal(email?.protocol, 'email_otp');
  assert.equal(email?.strategy, 'local_email_otp');
  assert.equal(providers.filter((provider) => provider.id === 'email').length, 1);
  assert.equal(providers.find((provider) => provider.id === 'google')?.status, 'active');

  await assert.rejects(
    service.beginOidc({}),
    (error: unknown) => error instanceof DomainError && error.code === 'social_provider_required',
  );
  assert.deepEqual(EMAIL_OTP_POLICY, {
    digits: 6,
    ttlMs: 5 * 60 * 1000,
    maxAttempts: 5,
    resendCooldownMs: 60 * 1000,
  });
});

test('offline CLI exchange returns refresh material once but persists only its hash', async () => {
  let persisted: RefreshSessionInput | undefined;
  const user = {
    id: 'e9eb8d93-6184-4f6a-ae3e-833ce093c406',
    email: 'desktop@example.test',
    displayName: 'Desktop User',
    platformRoles: [] as [],
  };
  const service = new AuthService(
    loadPlatformConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'test-session-secret-that-is-at-least-32-characters',
      OTP_PEPPER: 'test-otp-pepper-that-is-at-least-32-characters',
      WORKER_CALLBACK_TOKEN: 'test-worker-token-that-is-at-least-32-characters',
    }),
    {
      consumeCliAuthorization: async () => ({ user, offlineAccess: true }),
      createRefreshSession: async (input: RefreshSessionInput) => {
        persisted = input;
      },
    } as never,
    {} as never,
    {} as never,
    { consumePublicTokenExchange: async () => undefined } as never,
  );

  const result = await service.exchangeCliCode(
    {
      code: 'c'.repeat(64),
      codeVerifier: 'v'.repeat(64),
      redirectUri: 'http://127.0.0.1:54321/callback',
    },
    '127.0.0.1',
  );
  assert.ok(result.refreshToken);
  assert.ok(persisted);
  assert.match(persisted.refreshTokenHash, /^[a-f0-9]{64}$/);
  assert.notEqual(persisted.refreshTokenHash, result.refreshToken);
  assert.equal(JSON.stringify(persisted).includes(result.refreshToken), false);
});

test('production hybrid config fails closed without SMTP TLS or explicit authentication secrets', () => {
  const valid = productionHybridEnvironment();
  assert.equal(loadPlatformConfig(valid).AUTH_MODE, 'hybrid');

  for (const override of [
    { AUTH_MODE: 'oidc' },
    { EMAIL_DELIVERY: 'noop' },
    { SMTP_REQUIRE_TLS: 'false' },
    { SESSION_SECRET: 'development-only-secret-change-before-production' },
    { OTP_PEPPER: 'change-me-otp-pepper-at-least-32-characters' },
  ]) {
    assert.throws(() => loadPlatformConfig({ ...valid, ...override }));
  }
});

function productionHybridEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    API_PUBLIC_URL: 'https://workflow.example.test',
    WEB_PUBLIC_URL: 'https://workflow.example.test',
    REPOSITORY_MODE: 'postgres',
    DATABASE_URL: 'postgresql://workflow@example.test/workflow',
    REDIS_URL: 'redis://redis.example.test:6379',
    SESSION_SECRET: 'production-session-secret-that-is-at-least-32-characters',
    OTP_PEPPER: 'production-otp-pepper-that-is-at-least-32-characters',
    AUTH_MODE: 'hybrid',
    EMAIL_DELIVERY: 'smtp',
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '587',
    SMTP_REQUIRE_TLS: 'true',
    SMTP_USER: 'workflow',
    SMTP_PASSWORD: 'production-smtp-password',
    SMTP_FROM: 'Awesome Workflow <no-reply@example.test>',
    WORKER_CALLBACK_TOKEN: 'production-worker-token-that-is-at-least-32-characters',
    VALIDATION_QUEUE_MODE: 'redis',
    OBJECT_STORAGE_MODE: 's3',
    S3_ENDPOINT: 'https://objects.internal.example.test',
    S3_PUBLIC_ENDPOINT: 'https://artifacts.example.test',
    S3_ACCESS_KEY_ID: 'access-key',
    S3_SECRET_ACCESS_KEY: 'secret-key',
    OIDC_ISSUER: 'https://identity.example.test/oidc',
    OIDC_CLIENT_ID: 'web-client',
    OIDC_CLIENT_SECRET: 'production-oidc-client-secret',
    OIDC_REDIRECT_URI: 'https://workflow.example.test/api/v1/auth/oidc/callback',
    OIDC_POST_LOGIN_REDIRECT: 'https://workflow.example.test/',
  };
}
