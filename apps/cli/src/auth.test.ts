import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  assertCallbackState,
  createPkcePair,
  interactiveLogin,
  startLoopbackReceiver,
  workloadLogin,
} from './auth.js';

test('PKCE uses an RFC 7636 S256 challenge and callback state is strict', () => {
  const pair = createPkcePair((size) => Buffer.alloc(size, 7));
  assert.equal(pair.verifier.length, 64);
  assert.equal(pair.challenge, createHash('sha256').update(pair.verifier, 'ascii').digest('base64url'));
  assert.doesNotThrow(() => assertCallbackState('fixed-state', 'fixed-state'));
  assert.throws(() => assertCallbackState('fixed-state', 'fixed-statf'), /did not match/);
  assert.throws(() => assertCallbackState('fixed-state', null), /did not match/);
});

test('loopback receiver rejects a callback with the wrong state', async () => {
  const receiver = await startLoopbackReceiver('expected-state', 5_000);
  try {
    const callback = new URL(receiver.redirectUri);
    callback.searchParams.set('code', 'authorization-code');
    callback.searchParams.set('state', 'attacker-state');
    const response = await fetch(callback);
    assert.equal(response.status, 400);
    await assert.rejects(receiver.code, /did not match/);
  } finally {
    await receiver.close();
  }
});

test('interactive login fails clearly before opening a browser when CLI auth is unsupported', async () => {
  let opened = false;
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ title: 'Not Found' }), {
      status: 404,
      headers: { 'content-type': 'application/problem+json' },
    })) as typeof fetch;
  await assert.rejects(
    interactiveLogin({
      apiBaseUrl: 'https://api.example.test',
      fetchImpl,
      openBrowser: async () => {
        opened = true;
      },
    }),
    /does not support interactive CLI authentication/,
  );
  assert.equal(opened, false);
});

test('workload login reports the missing exchange endpoint without falling back to a long-lived token', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ title: 'Not Found' }), {
      status: 404,
      headers: { 'content-type': 'application/problem+json' },
    })) as typeof fetch;
  await assert.rejects(
    workloadLogin({
      apiBaseUrl: 'https://api.example.test',
      environment: { RUNNER_OIDC: 'unprinted-workload-token' },
      oidcEnvironmentName: 'RUNNER_OIDC',
      fetchImpl,
    }),
    /does not support workload authentication/,
  );
});
