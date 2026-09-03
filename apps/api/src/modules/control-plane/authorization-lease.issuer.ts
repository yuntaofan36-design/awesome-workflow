import { createHash, createPrivateKey, randomUUID, sign as signBytes, type KeyObject } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  AuthorizationLeaseClaimsSchema,
  AuthorizationLeaseSchema,
  RunClaimIntentSchema,
  ScheduleRecordIntentSchema,
  authorizationLeaseIntentPayload,
  authorizationLeaseSignaturePayload,
  type AuthorizationLease,
  type AuthorizationLeaseTask,
} from '@awesome-workflow/contracts';
import { CONFIG, type PlatformConfig } from '@awesome-workflow/config';

import { DomainError, invalidState } from '../../core/errors.js';

const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export type AuthorizationLeaseIssueInput = {
  revision: number;
  deviceId: string;
  applicationId: string;
  releaseId: string;
  appId: string;
  version: string;
  task: AuthorizationLeaseTask;
  capabilityHash: string;
  intent: unknown;
  grantExpiresAt?: string | null;
};

@Injectable()
export class AuthorizationLeaseIssuer {
  private readonly keyId?: string;
  private readonly privateKey?: KeyObject;
  private readonly ttlMs: number;

  constructor(@Inject(CONFIG) config: PlatformConfig) {
    this.keyId = config.AUTHORIZATION_LEASE_SIGNING_KEY_ID;
    this.ttlMs = config.AUTHORIZATION_LEASE_TTL_SECONDS * 1_000;
    if (config.AUTHORIZATION_LEASE_SIGNING_PRIVATE_KEY) {
      const seed = decodeSeed(config.AUTHORIZATION_LEASE_SIGNING_PRIVATE_KEY);
      this.privateKey = createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
        format: 'der',
        type: 'pkcs8',
      });
    }
  }

  assertAvailable(): void {
    if (!this.keyId || !this.privateKey) {
      throw new DomainError(
        503,
        'authorization_lease_signing_unavailable',
        'Authorization lease signing is not configured',
      );
    }
  }

  issue(input: AuthorizationLeaseIssueInput, now = new Date()): AuthorizationLease {
    this.assertAvailable();
    const issuedAt = now.getTime();
    const configuredExpiry = issuedAt + this.ttlMs;
    const grantExpiry = input.grantExpiresAt ? Date.parse(input.grantExpiresAt) : configuredExpiry;
    if (!Number.isFinite(grantExpiry) || grantExpiry <= issuedAt) {
      invalidState('The permission grant cannot authorize a non-positive offline lease window');
    }
    const expiresAt = Math.min(configuredExpiry, grantExpiry);
    const intent =
      input.task.kind === 'schedule'
        ? ScheduleRecordIntentSchema.parse(input.intent)
        : RunClaimIntentSchema.parse(input.intent);
    const intentHash = createHash('sha256').update(authorizationLeaseIntentPayload(intent)).digest('hex');
    const claims = AuthorizationLeaseClaimsSchema.parse({
      schemaVersion: 1,
      leaseId: randomUUID(),
      revision: input.revision,
      deviceId: input.deviceId,
      applicationId: input.applicationId,
      releaseId: input.releaseId,
      appId: input.appId,
      version: input.version,
      task: input.task,
      capabilityHash: input.capabilityHash,
      intentHash,
      issuedAt,
      expiresAt,
    });
    const payload = authorizationLeaseSignaturePayload(claims);
    return AuthorizationLeaseSchema.parse({
      claims,
      signature: {
        algorithm: 'ed25519',
        keyId: this.keyId!,
        value: signBytes(null, payload, this.privateKey!).toString('base64'),
      },
    });
  }
}

function decodeSeed(value: string): Buffer {
  const seed = Buffer.from(value, 'base64');
  if (seed.length !== 32 || seed.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) {
    throw new Error('AUTHORIZATION_LEASE_SIGNING_PRIVATE_KEY must be a canonical base64 Ed25519 seed');
  }
  return seed;
}
