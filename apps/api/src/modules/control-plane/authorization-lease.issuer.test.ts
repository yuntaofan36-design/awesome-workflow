import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto';
import test from 'node:test';

import {
  authorizationLeaseIntentPayload,
  authorizationLeaseSignaturePayload,
} from '@awesome-workflow/contracts';
import { loadPlatformConfig } from '@awesome-workflow/config';

import { DomainError } from '../../core/errors.js';
import { AuthorizationLeaseIssuer } from './authorization-lease.issuer.js';

const signingSeed = Buffer.alloc(32, 7).toString('base64');
const baseConfig = {
  NODE_ENV: 'test',
  AUTHORIZATION_LEASE_SIGNING_KEY_ID: 'lease-test-key',
  AUTHORIZATION_LEASE_SIGNING_PRIVATE_KEY: signingSeed,
  AUTHORIZATION_LEASE_TTL_SECONDS: '300',
};
const input = {
  revision: 9,
  deviceId: '11111111-1111-4111-8111-111111111111',
  applicationId: '22222222-2222-4222-8222-222222222222',
  releaseId: '33333333-3333-4333-8333-333333333333',
  appId: 'lease-test-app',
  version: '1.2.3',
  task: { kind: 'schedule' as const, id: '44444444-4444-4444-8444-444444444444' },
  capabilityHash: 'a'.repeat(64),
  intent: {
    scheduleId: '44444444-4444-4444-8444-444444444444',
    revision: 9,
    applicationId: '22222222-2222-4222-8222-222222222222',
    releaseId: '33333333-3333-4333-8333-333333333333',
    appId: 'lease-test-app',
    version: '1.2.3',
    cronExpression: '0 * * * *',
    timezone: 'UTC',
    nextRunAtMs: 1_800_000_600_000,
    args: ['--safe'],
    enabled: true,
  },
};

test('authorization lease issuer signs a bounded, fully scoped claim', () => {
  const issuer = new AuthorizationLeaseIssuer(loadPlatformConfig(baseConfig));
  const now = new Date('2026-09-02T00:00:00.000Z');
  const lease = issuer.issue(input, now);
  assert.equal(lease.claims.issuedAt, now.getTime());
  assert.equal(lease.claims.expiresAt, now.getTime() + 300_000);
  assert.equal(lease.claims.revision, 9);
  assert.equal(lease.claims.task.id, input.task.id);
  assert.equal(
    lease.claims.intentHash,
    createHash('sha256').update(authorizationLeaseIntentPayload(input.intent)).digest('hex'),
  );

  const privateKey = createEd25519PrivateKey(signingSeed);
  assert.equal(
    verify(
      null,
      authorizationLeaseSignaturePayload(lease.claims),
      createPublicKey(privateKey),
      Buffer.from(lease.signature.value, 'base64'),
    ),
    true,
  );
});

test('authorization lease never outlives its permission grant or hard configuration ceiling', () => {
  const issuer = new AuthorizationLeaseIssuer(loadPlatformConfig(baseConfig));
  const now = new Date('2026-09-02T00:00:00.000Z');
  const lease = issuer.issue(
    { ...input, grantExpiresAt: new Date(now.getTime() + 90_000).toISOString() },
    now,
  );
  assert.equal(lease.claims.expiresAt, now.getTime() + 90_000);
});

test('authorization lease issuance fails closed when the signing trust root is absent', () => {
  const issuer = new AuthorizationLeaseIssuer(loadPlatformConfig({ NODE_ENV: 'test' }));
  assert.throws(
    () => issuer.issue(input),
    (error) =>
      error instanceof DomainError &&
      error.status === 503 &&
      error.code === 'authorization_lease_signing_unavailable',
  );
});

function createEd25519PrivateKey(seed: string) {
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  return createPrivateKey({
    key: Buffer.concat([prefix, Buffer.from(seed, 'base64')]),
    format: 'der',
    type: 'pkcs8',
  });
}
