import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPlatformConfig } from '@awesome-workflow/config';

import { DomainError } from '../../core/errors.js';
import { LogtoOidcAdapter, logtoDiscoveryUrl, validateInternalReturnTo } from './logto.adapter.js';

test('Logto discovery preserves an issuer path component', () => {
  assert.equal(
    logtoDiscoveryUrl('https://identity.example.test/oidc').toString(),
    'https://identity.example.test/oidc/.well-known/openid-configuration',
  );
});

test('returnTo accepts only a same-origin path', () => {
  assert.equal(validateInternalReturnTo('/workspaces/current?tab=apps'), '/workspaces/current?tab=apps');
  for (const unsafe of ['//evil.example.test', 'https://evil.example.test', '/\\evil']) {
    assert.throws(
      () => validateInternalReturnTo(unsafe),
      (error: unknown) => error instanceof DomainError && error.code === 'invalid_return_to',
    );
  }
});

test('provider descriptors activate only enabled generic connectors and expose absolute broker URLs', () => {
  const adapter = new LogtoOidcAdapter(
    loadPlatformConfig({
      API_PUBLIC_URL: 'https://workflow.example.test',
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: 'https://identity.example.test/oidc',
      OIDC_CLIENT_ID: 'web-client',
      OIDC_CLIENT_SECRET: 'test-client-secret',
      OIDC_REDIRECT_URI: 'https://workflow.example.test/api/v1/auth/oidc/callback',
      OIDC_ENABLED_PROVIDERS: 'email,google',
    }),
    {} as never,
  );

  const providers = adapter.providers();
  assert.equal(providers.find((provider) => provider.id === 'google')?.status, 'active');
  assert.equal(providers.find((provider) => provider.id === 'feishu')?.status, 'disabled');
  assert.equal(
    providers.find((provider) => provider.id === 'google')?.authorizeUrl,
    'https://workflow.example.test/api/v1/auth/oidc/start?provider=google',
  );
});

test('social authorization uses Logto direct_sign_in and rejects disabled providers', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        issuer: 'https://identity.example.test/oidc',
        authorization_endpoint: 'https://identity.example.test/oidc/auth',
        token_endpoint: 'https://identity.example.test/oidc/token',
        jwks_uri: 'https://identity.example.test/oidc/jwks',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  const transactions: unknown[] = [];
  const adapter = new LogtoOidcAdapter(
    loadPlatformConfig({
      API_PUBLIC_URL: 'https://workflow.example.test',
      AUTH_MODE: 'hybrid',
      OIDC_ISSUER: 'https://identity.example.test/oidc',
      OIDC_CLIENT_ID: 'web-client',
      OIDC_CLIENT_SECRET: 'test-client-secret',
      OIDC_REDIRECT_URI: 'https://workflow.example.test/api/v1/auth/oidc/callback',
      OIDC_ENABLED_PROVIDERS: 'google',
    }),
    {
      createOidcTransaction: async (transaction: unknown) => {
        transactions.push(transaction);
      },
    } as never,
  );

  const result = await adapter.begin({ provider: 'google', returnTo: '/security' });
  const authorizationUrl = new URL(result.authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get('direct_sign_in'), 'social:google');
  assert.equal(authorizationUrl.searchParams.has('connector'), false);
  assert.equal(transactions.length, 1);

  await assert.rejects(
    adapter.begin({ provider: 'feishu' }),
    (error: unknown) => error instanceof DomainError && error.code === 'social_provider_disabled',
  );
});
