import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApprovePermissionGrantInputSchema,
  AuthorizationLeaseSchema,
  DeviceCredentialSchema,
  DeviceSchema,
  ListDevicesQuerySchema,
  PermissionGrantPreviewSchema,
  PermissionGrantSchema,
  RegisterDeviceResultSchema,
  ReportRunStatusInputSchema,
  RunCancellationListResultSchema,
  RunClaimSchema,
  RunStatusSchema,
  ScheduleDeltaSchema,
  ScheduleSnapshotSchema,
  ScheduleSyncResultSchema,
  UpdateInstallationStatusInputSchema,
  UpdateScheduleInputSchema,
  applyScheduleDelta,
  canonicalizeAuthorizationLeaseClaims,
} from './index.js';

const firstScheduleId = '11111111-1111-4111-8111-111111111111';
const secondScheduleId = '22222222-2222-4222-8222-222222222222';
const workspaceId = '44444444-4444-4444-8444-444444444444';
const deviceId = '55555555-5555-4555-8555-555555555555';
const userId = '66666666-6666-4666-8666-666666666666';
const applicationId = '77777777-7777-4777-8777-777777777777';
const releaseId = '88888888-8888-4888-8888-888888888888';
const grantId = '99999999-9999-4999-8999-999999999999';
const capabilityHash = 'a'.repeat(64);

const authorizationLease = (
  kind: 'schedule' | 'run',
  id: string,
  revision = 1,
  appId = 'sample-desktop',
  version = '1.2.3',
) => ({
  claims: {
    schemaVersion: 1 as const,
    leaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    revision,
    deviceId,
    applicationId,
    releaseId,
    appId,
    version,
    task: { kind, id },
    capabilityHash,
    intentHash: 'b'.repeat(64),
    issuedAt: 1_800_000_000_000,
    expiresAt: 1_800_000_300_000,
  },
  signature: { algorithm: 'ed25519' as const, keyId: 'lease-test-key', value: 'A'.repeat(88) },
});

test('authorization lease contract is bounded, task-scoped and canonical', () => {
  const lease = AuthorizationLeaseSchema.parse(authorizationLease('run', firstScheduleId));
  assert.equal(lease.claims.task.id, firstScheduleId);
  assert.match(canonicalizeAuthorizationLeaseClaims(lease.claims), /^\{"appId":/u);
  assert.equal(
    AuthorizationLeaseSchema.safeParse({
      ...lease,
      claims: { ...lease.claims, expiresAt: lease.claims.issuedAt },
    }).success,
    false,
  );
});

test('device registration returns an explicit one-time credential outside the public device shape', () => {
  const credential = `awd_${'A'.repeat(43)}`;
  assert.equal(DeviceCredentialSchema.safeParse(credential).success, true);
  assert.equal(DeviceCredentialSchema.safeParse('human-session-token').success, false);

  const result = RegisterDeviceResultSchema.parse({
    device: {
      id: '55555555-5555-4555-8555-555555555555',
      workspaceId: '44444444-4444-4444-8444-444444444444',
      ownerId: '66666666-6666-4666-8666-666666666666',
      name: 'Windows workstation',
      os: 'windows',
      arch: 'x64',
      agentVersion: '1.0.0',
      publicKeyThumbprint: 'sha256:device-registration-test',
      status: 'active',
      lastSeenAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
    },
    credential,
  });
  assert.equal(result.credential, credential);
  assert.equal('credential' in result.device, false);
  assert.equal('credentialHash' in DeviceSchema.parse({ ...result.device, credentialHash: 'secret' }), false);
});

test('run state vocabularies preserve server authority and device-reportable states', () => {
  assert.deepEqual(RunStatusSchema.options, [
    'queued',
    'dispatched',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'needs_user_approval',
  ]);

  assert.equal(
    ReportRunStatusInputSchema.safeParse({
      attempt: 2,
      status: 'needs_user_approval',
      errorCode: 'elevation_required',
    }).success,
    true,
  );
  assert.equal(ReportRunStatusInputSchema.safeParse({ attempt: 2, status: 'queued' }).success, false);
  assert.equal(ReportRunStatusInputSchema.safeParse({ attempt: 2, status: 'cancelled' }).success, true);
  assert.equal(
    RunCancellationListResultSchema.safeParse([
      {
        runId: '33333333-3333-4333-8333-333333333333',
        attempt: 2,
        cancelRequestedAt: '2026-09-01T00:00:00.000Z',
      },
    ]).success,
    true,
  );
});

test('device list and installation reports carry their server authority boundaries', () => {
  assert.equal(ListDevicesQuerySchema.safeParse({}).success, false);
  assert.equal(
    ListDevicesQuerySchema.safeParse({ workspaceId: '44444444-4444-4444-8444-444444444444' }).success,
    true,
  );
  assert.equal(
    UpdateInstallationStatusInputSchema.safeParse({
      status: 'failed',
      errorCode: 'artifact_verification_failed',
    }).success,
    true,
  );
  assert.equal(UpdateInstallationStatusInputSchema.safeParse({ status: 'requested' }).success, false);
});

test('permission approval input is strict and never accepts client-declared capabilities or scope', () => {
  const input = {
    releaseId,
    expectedCapabilityHash: capabilityHash,
    expiresAt: '2026-09-02T12:00:00.000Z',
  };
  assert.deepEqual(ApprovePermissionGrantInputSchema.parse(input), input);

  for (const untrustedField of [
    { capabilities: [{ kind: 'notifications' }] },
    { workspaceId },
    { deviceId },
    { applicationId },
    { grantedBy: userId },
    { status: 'active' },
  ]) {
    assert.equal(
      ApprovePermissionGrantInputSchema.safeParse({ ...input, ...untrustedField }).success,
      false,
      `approval accepted untrusted field ${Object.keys(untrustedField)[0]}`,
    );
  }
  assert.equal(ApprovePermissionGrantInputSchema.safeParse({ releaseId }).success, false);
  assert.equal(
    ApprovePermissionGrantInputSchema.safeParse({ ...input, expectedCapabilityHash: 'not-a-digest' }).success,
    false,
  );
});

test('permission preview and grant expose the server-derived device and release scope', () => {
  const capabilities = [
    {
      kind: 'filesystem' as const,
      access: 'read-write' as const,
      scopes: [{ scope: 'user-selected' as const }],
    },
  ];
  const preview = PermissionGrantPreviewSchema.parse({
    workspaceId,
    deviceId,
    applicationId,
    releaseId,
    capabilities,
    capabilityHash,
    approvalRequired: true,
  });
  assert.equal(preview.capabilityHash, capabilityHash);
  assert.deepEqual(preview.capabilities, capabilities);

  const grant = PermissionGrantSchema.parse({
    ...preview,
    id: grantId,
    status: 'active',
    grantedBy: userId,
    revokedAt: null,
    expiresAt: null,
    createdAt: '2026-09-02T00:00:00.000Z',
  });
  assert.equal(grant.deviceId, deviceId);
  assert.equal(grant.releaseId, releaseId);
});

test('run claims contain the complete Agent execution projection', () => {
  const claim = RunClaimSchema.parse({
    runId: '33333333-3333-4333-8333-333333333333',
    attempt: 1,
    appId: 'sample-desktop',
    version: '1.2.3',
    args: ['--mode', 'scheduled'],
    requiresElevation: false,
    authorizationLease: authorizationLease('run', '33333333-3333-4333-8333-333333333333'),
  });

  assert.deepEqual(claim.args, ['--mode', 'scheduled']);
  assert.equal(claim.appId, 'sample-desktop');
});

test('schedule sync snapshots match the Agent shape and deltas reconstruct a full snapshot', () => {
  const snapshot = ScheduleSnapshotSchema.parse({
    revision: 4,
    schedules: [
      {
        scheduleId: firstScheduleId,
        revision: 4,
        applicationId,
        releaseId,
        appId: 'sample-desktop',
        version: '1.0.0',
        cronExpression: '0 2 * * *',
        timezone: 'Asia/Shanghai',
        nextRunAtMs: 1_800_000_000_000,
        args: ['--old'],
        enabled: true,
        authorizationLease: authorizationLease('schedule', firstScheduleId, 4, 'sample-desktop', '1.0.0'),
      },
    ],
  });
  assert.deepEqual(Object.keys(snapshot), ['revision', 'schedules']);

  const delta = ScheduleDeltaSchema.parse({
    fromRevision: 4,
    toRevision: 5,
    upserts: [
      {
        scheduleId: secondScheduleId,
        revision: 5,
        applicationId,
        releaseId,
        appId: 'another-desktop',
        cronExpression: '0 2 * * *',
        timezone: 'Asia/Shanghai',
        nextRunAtMs: 1_800_000_100_000,
        args: [],
        enabled: false,
        authorizationLease: authorizationLease('schedule', secondScheduleId, 5, 'another-desktop'),
      },
    ],
    removedScheduleIds: [firstScheduleId],
  });
  const next = applyScheduleDelta(snapshot, delta);

  assert.deepEqual(next, {
    revision: 5,
    schedules: [
      {
        scheduleId: secondScheduleId,
        revision: 5,
        applicationId,
        releaseId,
        appId: 'another-desktop',
        cronExpression: '0 2 * * *',
        timezone: 'Asia/Shanghai',
        nextRunAtMs: 1_800_000_100_000,
        args: [],
        enabled: false,
        authorizationLease: authorizationLease('schedule', secondScheduleId, 5, 'another-desktop'),
      },
    ],
  });
  assert.equal(ScheduleSyncResultSchema.safeParse({ kind: 'delta', delta }).success, true);
  assert.throws(
    () => applyScheduleDelta({ revision: 3, schedules: [] }, delta),
    /current snapshot is revision 3/,
  );
});

test('schedule deltas reject ambiguous mutations and schedule updates require optimistic concurrency', () => {
  assert.equal(
    ScheduleDeltaSchema.safeParse({
      fromRevision: 2,
      toRevision: 1,
      upserts: [],
      removedScheduleIds: [],
    }).success,
    false,
  );
  assert.equal(
    ScheduleDeltaSchema.safeParse({
      fromRevision: 1,
      toRevision: 2,
      upserts: [
        {
          scheduleId: firstScheduleId,
          revision: 1,
          applicationId,
          releaseId,
          appId: 'sample-desktop',
          cronExpression: '0 2 * * *',
          timezone: 'UTC',
          nextRunAtMs: 1_000,
          args: [],
          enabled: true,
          authorizationLease: authorizationLease('schedule', firstScheduleId),
        },
      ],
      removedScheduleIds: [firstScheduleId],
    }).success,
    false,
  );
  assert.equal(UpdateScheduleInputSchema.safeParse({ expectedRevision: 3 }).success, false);
  assert.equal(
    UpdateScheduleInputSchema.safeParse({ expectedRevision: 3, nextRunAtMs: 1_800_000_200_000 }).success,
    true,
  );
});
