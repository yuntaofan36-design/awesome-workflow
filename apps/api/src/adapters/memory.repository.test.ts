import assert from 'node:assert/strict';
import test from 'node:test';

import { computeDesktopCapabilityHash, type DesktopReleaseManifest } from '@awesome-workflow/manifest-schema';

import { DomainError } from '../core/errors.js';
import { MemoryPlatformRepository } from './memory.repository.js';

test('keeps different issuer/subject identities separate even when their verified email matches', async () => {
  const repository = new MemoryPlatformRepository();
  const first = await repository.upsertIdentity({
    issuer: 'local-email',
    subject: 'person@example.test',
    email: 'person@example.test',
    displayName: 'Person',
    platformRoles: [],
  });

  const second = await repository.upsertIdentity({
    issuer: 'https://identity.example.test/oidc',
    subject: 'external-subject',
    email: 'person@example.test',
    displayName: 'Person from OIDC',
    platformRoles: [],
  });
  assert.notEqual(second.id, first.id);
  assert.equal((await repository.listWorkspaces(second.id)).length, 1);

  const sameIdentity = await repository.upsertIdentity({
    issuer: 'local-email',
    subject: 'person@example.test',
    email: 'person@example.test',
    displayName: 'Person',
    platformRoles: [],
  });
  assert.equal(sameIdentity.id, first.id);
});

test('release follows draft, uploading, validating, ready, approved', async () => {
  const repository = new MemoryPlatformRepository();
  const publisher = await repository.upsertIdentity({
    issuer: 'local-email',
    subject: 'publisher@example.test',
    email: 'publisher@example.test',
    displayName: 'Publisher',
    platformRoles: ['official_reviewer'],
  });
  const [workspace] = await repository.listWorkspaces(publisher.id);
  assert.ok(workspace);
  const application = await repository.createApplication({
    workspaceId: workspace.id,
    slug: 'sample-app',
    name: 'Sample app',
    summary: 'State-machine test',
    kind: 'web',
    createdBy: publisher.id,
  });
  const sha256 = 'a'.repeat(64);
  const signature = { algorithm: 'ed25519' as const, keyId: 'test-key', value: 'A'.repeat(88) };
  const sbom = {
    format: 'cyclonedx-json' as const,
    fileName: 'sbom.cdx.json',
    mediaType: 'application/vnd.cyclonedx+json' as const,
    sha256,
  };
  const release = await repository.createRelease({
    applicationId: application.id,
    version: '1.0.0',
    manifestSha256: sha256,
    signature,
    sbom,
    createdBy: publisher.id,
    manifest: {
      schemaVersion: 1,
      appId: 'sample-app',
      version: '1.0.0',
      artifacts: [
        {
          name: 'bundle',
          fileName: 'bundle.awpkg',
          mediaType: 'application/zip',
          size: 1024,
          sha256,
        },
      ],
      integrity: { algorithm: 'sha256', digest: sha256 },
      signature,
      kind: 'web',
      runtime: 'iframe',
      routeBase: '/sample',
      hostApiVersion: '1',
      capabilities: ['context.read'],
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: [],
      },
      url: 'https://example.test/app',
      allowedOrigin: 'https://example.test',
      sandbox: ['allow-scripts'],
      trustTier: 'isolated',
    },
  });
  assert.equal(release.status, 'draft');
  const [draftListItem] = await repository.listReleases({
    workspaceId: workspace.id,
    kind: 'web',
    status: 'draft',
  });
  assert.equal(draftListItem?.release.id, release.id);
  assert.equal(draftListItem?.artifactCount, 0);
  const artifact = await repository.createArtifact({
    releaseId: release.id,
    fileName: 'bundle.awpkg',
    contentType: 'application/zip',
    size: 1024,
    sha256,
    signature,
    sbom,
    storageKey: `releases/${release.id}/bundle.awpkg`,
    sbomStorageKey: `releases/${release.id}/sbom.cdx.json`,
  });
  assert.equal((await repository.getRelease(release.id)).status, 'uploading');
  await repository.finalizeArtifact(artifact.id, undefined);
  assert.equal((await repository.submitRelease(release.id)).release.status, 'validating');
  const evidence = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      validator: 'test-validator',
      check: 'digest' as const,
      outcome: 'passed' as const,
      observedAt: '2026-09-01T00:00:00.000Z',
      details: {},
    },
  ];
  assert.equal(
    (
      await repository.applyValidationResult({
        releaseId: release.id,
        success: true,
        artifactIds: [artifact.id],
        releaseEvidence: evidence,
        artifactEvidence: { [artifact.id]: evidence },
      })
    ).release.status,
    'ready',
  );
  const [pendingReview] = await repository.listReleases({
    workspaceId: workspace.id,
    status: 'ready',
  });
  assert.equal(pendingReview?.release.id, release.id);
  assert.equal(pendingReview?.artifactCount, 1);
  assert.equal(
    (
      await repository.createReview({
        releaseId: release.id,
        reviewerId: publisher.id,
        decision: 'approve',
        comment: 'Validated',
      })
    ).release.status,
    'approved',
  );
  assert.equal((await repository.listReleases({ workspaceId: workspace.id, status: 'ready' })).length, 0);
});

test('desktop control plane preserves release, revision, installation and run state invariants', async () => {
  const repository = new MemoryPlatformRepository();
  const owner = await repository.upsertIdentity({
    issuer: 'local-email',
    subject: 'desktop-owner@example.test',
    email: 'desktop-owner@example.test',
    displayName: 'Desktop owner',
    platformRoles: ['official_reviewer'],
  });
  const [workspace] = await repository.listWorkspaces(owner.id);
  assert.ok(workspace);

  const device = await repository.registerDevice({
    workspaceId: workspace.id,
    ownerId: owner.id,
    name: 'Windows workstation',
    os: 'windows',
    arch: 'x64',
    agentVersion: '1.0.0',
    publicKeyThumbprint: 'sha256:desktop-owner-device-key',
    credentialHash: 'c'.repeat(64),
  });
  assert.equal((await repository.findActiveDeviceByCredentialHash('c'.repeat(64)))?.id, device.id);
  assert.equal(await repository.findActiveDeviceByCredentialHash('f'.repeat(64)), null);
  assert.equal('credentialHash' in (await repository.getDevice(device.id)), false);
  assert.equal('credentialHash' in (await repository.listDevices({ workspaceId: workspace.id }))[0]!, false);

  const webApplication = await repository.createApplication({
    workspaceId: workspace.id,
    slug: 'approved-web-app',
    name: 'Approved web app',
    summary: 'Must never be installed as a desktop app',
    kind: 'web',
    createdBy: owner.id,
  });
  const webArtifact = artifactDeclaration('web-bundle');
  const webRelease = await repository.createRelease({
    applicationId: webApplication.id,
    version: '1.0.0',
    manifestSha256: 'c'.repeat(64),
    signature: testSignature,
    sbom: testSbom,
    createdBy: owner.id,
    manifest: {
      schemaVersion: 1,
      appId: webApplication.slug,
      version: '1.0.0',
      artifacts: [webArtifact],
      integrity: { algorithm: 'sha256', digest: 'c'.repeat(64) },
      signature: testSignature,
      kind: 'web',
      runtime: 'iframe',
      routeBase: '/approved-web-app',
      hostApiVersion: '1',
      capabilities: ['context.read'],
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: [],
      },
      url: 'https://web.example.test/app',
      allowedOrigin: 'https://web.example.test',
      sandbox: ['allow-scripts'],
      trustTier: 'isolated',
    },
  });
  await approveRelease(repository, webRelease.id, webArtifact, owner.id);
  await assert.rejects(
    repository.requestInstallation({
      workspaceId: workspace.id,
      deviceId: device.id,
      applicationId: webApplication.id,
      releaseId: webRelease.id,
      requestedBy: owner.id,
    }),
    isDomainError(409, 'invalid_state'),
  );

  const desktopApplication = await repository.createApplication({
    workspaceId: workspace.id,
    slug: 'desktop-runner',
    name: 'Desktop runner',
    summary: 'Desktop control-plane state test',
    kind: 'desktop',
    createdBy: owner.id,
  });
  const desktopArtifact = artifactDeclaration('windows-x64');
  const desktopManifest: DesktopReleaseManifest = {
    schemaVersion: 1,
    appId: desktopApplication.slug,
    version: '2.3.4',
    artifacts: [desktopArtifact],
    integrity: { algorithm: 'sha256', digest: 'd'.repeat(64) },
    signature: testSignature,
    kind: 'desktop',
    name: 'Desktop runner',
    description: 'Runs a signed native micro-application',
    defaultLocale: 'en-US',
    localizations: {},
    runtimes: [
      {
        kind: 'native',
        platform: { os: 'windows', arch: 'x64' },
        artifact: desktopArtifact.name,
        entry: 'bin/desktop-runner.exe',
      },
    ],
    dependencies: [],
    capabilities: [
      {
        kind: 'lifecycle',
        actions: ['install', 'update'],
        elevation: 'user-approved',
      },
    ],
    runMode: 'serial',
    minHostVersion: '1.0.0',
  };
  const desktopRelease = await repository.createRelease({
    applicationId: desktopApplication.id,
    version: desktopManifest.version,
    manifest: desktopManifest,
    manifestSha256: 'd'.repeat(64),
    signature: testSignature,
    sbom: testSbom,
    createdBy: owner.id,
  });

  const installationRequest = {
    workspaceId: workspace.id,
    deviceId: device.id,
    applicationId: desktopApplication.id,
    releaseId: desktopRelease.id,
    requestedBy: owner.id,
  };
  await assert.rejects(
    repository.requestInstallation(installationRequest),
    isDomainError(409, 'invalid_state'),
  );
  await approveRelease(repository, desktopRelease.id, desktopArtifact, owner.id);

  const scheduleRequest = {
    workspaceId: workspace.id,
    applicationId: desktopApplication.id,
    releaseId: desktopRelease.id,
    targetDeviceId: device.id,
    name: 'Nightly desktop run',
    cronExpression: '0 2 * * *',
    timezone: 'Asia/Shanghai',
    nextRunAtMs: 1_800_000_000_000,
    input: { args: ['--initial'] },
    createdBy: owner.id,
  };
  const manualRunRequest = {
    workspaceId: workspace.id,
    deviceId: device.id,
    applicationId: desktopApplication.id,
    releaseId: desktopRelease.id,
    input: { args: ['--manual'] },
    triggeredBy: owner.id,
  };
  for (const operation of [
    () => repository.requestInstallation(installationRequest),
    () => repository.createSchedule(scheduleRequest),
    () => repository.createManualRun(manualRunRequest),
  ]) {
    await assert.rejects(operation(), isDomainError(409, 'permission_approval_required'));
  }

  const capabilityHash = await computeDesktopCapabilityHash(desktopManifest.capabilities);
  await assert.rejects(
    repository.approvePermissionGrant({
      deviceId: device.id,
      releaseId: desktopRelease.id,
      grantedBy: owner.id,
      expectedCapabilityHash: '0'.repeat(64),
      now: new Date('2026-09-02T00:00:00.000Z'),
    }),
    isDomainError(409, 'permission_requirement_changed'),
  );

  const expiredGrant = await repository.approvePermissionGrant({
    deviceId: device.id,
    releaseId: desktopRelease.id,
    grantedBy: owner.id,
    expectedCapabilityHash: capabilityHash,
    now: new Date('2020-01-01T00:00:00.000Z'),
    expiresAt: new Date('2020-01-02T00:00:00.000Z'),
  });
  assert.equal((await repository.getPermissionGrant(expiredGrant.id)).status, 'expired');
  for (const operation of [
    () => repository.requestInstallation(installationRequest),
    () => repository.createSchedule(scheduleRequest),
    () => repository.createManualRun(manualRunRequest),
  ]) {
    await assert.rejects(operation(), isDomainError(409, 'permission_approval_required'));
  }

  const grant = await repository.approvePermissionGrant({
    deviceId: device.id,
    releaseId: desktopRelease.id,
    grantedBy: owner.id,
    expectedCapabilityHash: capabilityHash,
    now: new Date(),
  });
  assert.equal(grant.id, expiredGrant.id);
  assert.equal(grant.status, 'active');
  assert.equal(grant.capabilityHash, capabilityHash);
  assert.deepEqual(grant.capabilities, desktopManifest.capabilities);
  assert.deepEqual(
    (await repository.listPermissionGrants({ workspaceId: workspace.id, status: 'active' })).map(
      (candidate) => candidate.id,
    ),
    [grant.id],
  );

  const installation = await repository.requestInstallation(installationRequest);
  await assert.rejects(
    repository.updateInstallationStatus({ id: installation.id, deviceId: device.id, status: 'installed' }),
    isDomainError(409, 'invalid_state'),
  );
  assert.equal(
    (
      await repository.updateInstallationStatus({
        id: installation.id,
        deviceId: device.id,
        status: 'downloading',
      })
    ).status,
    'downloading',
  );
  assert.equal(
    (
      await repository.updateInstallationStatus({
        id: installation.id,
        deviceId: device.id,
        status: 'installed',
      })
    ).status,
    'installed',
  );

  const schedule = await repository.createSchedule(scheduleRequest);
  assert.equal(schedule.revision, 1);
  const snapshot = await repository.syncSchedules(device.id, {});
  assert.equal(snapshot.kind, 'snapshot');
  assert.deepEqual(snapshot.kind === 'snapshot' ? snapshot.snapshot.schedules[0]?.args : [], ['--initial']);

  const updatedSchedule = await repository.updateSchedule(schedule.id, {
    expectedRevision: schedule.revision,
    nextRunAtMs: 1_800_000_000_500,
    input: { args: ['--updated'] },
    actorId: owner.id,
  });
  assert.equal(updatedSchedule.revision, 2);
  await assert.rejects(
    repository.updateSchedule(schedule.id, {
      expectedRevision: schedule.revision,
      name: 'Stale update',
      actorId: owner.id,
    }),
    isDomainError(409, 'schedule_changed'),
  );
  const delta = await repository.syncSchedules(device.id, { revision: schedule.revision });
  assert.equal(delta.kind, 'delta');
  if (delta.kind === 'delta') {
    assert.equal(delta.delta.fromRevision, 1);
    assert.equal(delta.delta.toRevision, 2);
    assert.deepEqual(delta.delta.upserts[0]?.args, ['--updated']);
  }

  const paused = await repository.pauseSchedule(schedule.id, {
    expectedRevision: updatedSchedule.revision,
    paused: true,
    actorId: owner.id,
  });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.revision, 3);

  const expiringGrant = await repository.approvePermissionGrant({
    deviceId: device.id,
    releaseId: desktopRelease.id,
    grantedBy: owner.id,
    expectedCapabilityHash: capabilityHash,
    now: new Date('2020-01-01T00:00:00.000Z'),
    expiresAt: new Date('2020-01-02T00:00:00.000Z'),
  });
  assert.equal((await repository.getPermissionGrant(expiringGrant.id)).status, 'expired');
  const expirationDelta = await repository.syncSchedules(device.id, { revision: paused.revision });
  assert.equal(expirationDelta.kind, 'delta');
  if (expirationDelta.kind === 'delta') {
    assert.equal(expirationDelta.delta.fromRevision, paused.revision);
    assert.equal(expirationDelta.delta.toRevision, paused.revision + 1);
    assert.deepEqual(expirationDelta.delta.upserts, []);
    assert.deepEqual(expirationDelta.delta.removedScheduleIds, [schedule.id]);
  }
  const expiredSchedule = await repository.getSchedule(schedule.id);
  assert.equal(expiredSchedule.status, 'disabled');
  await assert.rejects(
    repository.pauseSchedule(schedule.id, {
      expectedRevision: expiredSchedule.revision,
      paused: false,
      actorId: owner.id,
    }),
    isDomainError(409, 'permission_approval_required'),
  );
  assert.equal((await repository.getSchedule(schedule.id)).status, 'disabled');

  const reapprovedAfterExpiry = await repository.approvePermissionGrant({
    deviceId: device.id,
    releaseId: desktopRelease.id,
    grantedBy: owner.id,
    expectedCapabilityHash: capabilityHash,
    now: new Date(),
  });
  assert.equal(reapprovedAfterExpiry.id, grant.id);
  assert.equal((await repository.getSchedule(schedule.id)).status, 'disabled');
  const resumedAfterExpiry = await repository.pauseSchedule(schedule.id, {
    expectedRevision: expiredSchedule.revision,
    paused: false,
    actorId: owner.id,
  });
  assert.equal(resumedAfterExpiry.status, 'active');

  const run = await repository.createManualRun(manualRunRequest);
  const claims = await repository.claimRuns(device.id, { limit: 1 });
  assert.deepEqual(claims, [
    {
      runId: run.id,
      attempt: 1,
      appId: desktopApplication.slug,
      version: desktopRelease.version,
      args: ['--manual'],
      requiresElevation: true,
      applicationId: desktopApplication.id,
      releaseId: desktopRelease.id,
      capabilityHash,
      grantExpiresAt: null,
    },
  ]);
  assert.equal(
    (
      await repository.reportRun({
        runId: run.id,
        deviceId: device.id,
        attempt: 1,
        status: 'needs_user_approval',
        errorCode: 'elevation_required',
      })
    ).status,
    'needs_user_approval',
  );
  assert.equal(
    (
      await repository.reportRun({
        runId: run.id,
        deviceId: device.id,
        attempt: 1,
        status: 'running',
      })
    ).status,
    'running',
  );
  assert.equal(
    (
      await repository.reportRun({
        runId: run.id,
        deviceId: device.id,
        attempt: 1,
        status: 'succeeded',
        result: { exitCode: 0 },
      })
    ).status,
    'succeeded',
  );
  assert.equal(
    (
      await repository.reportRun({
        runId: run.id,
        deviceId: device.id,
        attempt: 1,
        status: 'succeeded',
        result: { exitCode: 0 },
      })
    ).status,
    'succeeded',
  );
  await assert.rejects(
    repository.reportRun({
      runId: run.id,
      deviceId: device.id,
      attempt: 1,
      status: 'succeeded',
      result: { exitCode: 1 },
    }),
    isDomainError(409, 'run_report_mismatch'),
  );

  const cancellableRun = await repository.createManualRun({
    workspaceId: workspace.id,
    deviceId: device.id,
    applicationId: desktopApplication.id,
    releaseId: desktopRelease.id,
    input: { args: ['--cancel-me'] },
    triggeredBy: owner.id,
  });
  await repository.claimRuns(device.id, { limit: 1 });
  const cancellationRequested = await repository.cancelRun(cancellableRun.id, owner.id);
  assert.equal(cancellationRequested.status, 'dispatched');
  assert.ok(cancellationRequested.cancelRequestedAt);
  assert.deepEqual(await repository.listRunCancellations(device.id), [
    {
      runId: cancellableRun.id,
      attempt: 1,
      cancelRequestedAt: cancellationRequested.cancelRequestedAt,
    },
  ]);
  for (let replay = 0; replay < 2; replay += 1) {
    assert.equal(
      (
        await repository.reportRun({
          runId: cancellableRun.id,
          deviceId: device.id,
          attempt: 1,
          status: 'cancelled',
          errorCode: 'cancelled_by_user',
        })
      ).status,
      'cancelled',
    );
  }
  assert.deepEqual(await repository.listRunCancellations(device.id), []);

  const revokedQueuedRun = await repository.createManualRun({
    ...manualRunRequest,
    input: { args: ['--revoked-before-claim'] },
  });
  const revokedGrant = await repository.revokePermissionGrant(grant.id, owner.id);
  assert.equal(revokedGrant.status, 'revoked');
  assert.ok(revokedGrant.revokedAt);
  const scheduleDisabledByRevocation = await repository.getSchedule(schedule.id);
  assert.equal(scheduleDisabledByRevocation.status, 'disabled');
  await assert.rejects(
    repository.pauseSchedule(schedule.id, {
      expectedRevision: scheduleDisabledByRevocation.revision,
      paused: false,
      actorId: owner.id,
    }),
    isDomainError(409, 'permission_approval_required'),
  );
  assert.deepEqual(await repository.claimRuns(device.id, { limit: 1 }), []);
  const permissionDeniedRun = await repository.getRun(revokedQueuedRun.id);
  assert.equal(permissionDeniedRun.status, 'failed');
  assert.equal(permissionDeniedRun.errorCode, 'permission_grant_inactive');
  for (const operation of [
    () => repository.requestInstallation(installationRequest),
    () => repository.createSchedule({ ...scheduleRequest, name: 'Revoked schedule' }),
    () => repository.createManualRun(manualRunRequest),
  ]) {
    await assert.rejects(operation(), isDomainError(409, 'permission_approval_required'));
  }

  const reapprovedAfterRevocation = await repository.approvePermissionGrant({
    deviceId: device.id,
    releaseId: desktopRelease.id,
    grantedBy: owner.id,
    expectedCapabilityHash: capabilityHash,
    now: new Date(),
  });
  assert.equal(reapprovedAfterRevocation.id, grant.id);
  assert.equal((await repository.getSchedule(schedule.id)).status, 'disabled');
  const resumedAfterRevocation = await repository.pauseSchedule(schedule.id, {
    expectedRevision: scheduleDisabledByRevocation.revision,
    paused: false,
    actorId: owner.id,
  });
  assert.equal(resumedAfterRevocation.status, 'active');
  const restoredScheduleDelta = await repository.syncSchedules(device.id, {
    revision: scheduleDisabledByRevocation.revision,
  });
  assert.equal(restoredScheduleDelta.kind, 'delta');
  if (restoredScheduleDelta.kind === 'delta') {
    assert.deepEqual(restoredScheduleDelta.delta.removedScheduleIds, []);
    assert.equal(restoredScheduleDelta.delta.upserts[0]?.scheduleId, schedule.id);
    assert.equal(restoredScheduleDelta.delta.upserts[0]?.enabled, true);
  }

  const actions = (await repository.listAuditEvents(workspace.id)).map((event) => event.action);
  for (const action of [
    'device.registered',
    'installation.requested',
    'schedule.created',
    'schedule.updated',
    'schedule.paused',
    'schedule.resumed',
    'schedule.permission_expired',
    'run.created',
    'run.claimed',
    'run.status_reported',
    'run.cancel_requested',
    'permission_grant.approved',
    'permission_grant.revoked',
    'schedule.permission_revoked',
    'run.permission_revoked',
  ]) {
    assert.equal(actions.includes(action), true, `missing audit action ${action}`);
  }

  const deviceActions = (await repository.listAuditEvents(workspace.id)).filter((event) =>
    ['installation.status_changed', 'run.claimed', 'run.status_reported'].includes(event.action),
  );
  assert.equal(
    deviceActions.every((event) => event.actorType === 'device' && event.actorId === device.id),
    true,
  );

  await repository.revokeDevice(device.id, owner.id);
  assert.equal(await repository.findActiveDeviceByCredentialHash('c'.repeat(64)), null);
  await assert.rejects(repository.claimRuns(device.id, { limit: 1 }), isDomainError(409, 'invalid_state'));
});

const testSignature = {
  algorithm: 'ed25519' as const,
  keyId: 'desktop-test-key',
  value: 'A'.repeat(88),
};
const testSbom = {
  format: 'cyclonedx-json' as const,
  fileName: 'desktop-sbom.cdx.json',
  mediaType: 'application/vnd.cyclonedx+json' as const,
  sha256: 'b'.repeat(64),
};

function artifactDeclaration(name: string) {
  return {
    name,
    fileName: `${name}.zip`,
    mediaType: 'application/zip',
    size: 2_048,
    sha256: 'a'.repeat(64),
  };
}

async function approveRelease(
  repository: MemoryPlatformRepository,
  releaseId: string,
  declaration: ReturnType<typeof artifactDeclaration>,
  reviewerId: string,
): Promise<void> {
  const artifact = await repository.createArtifact({
    releaseId,
    fileName: declaration.fileName,
    contentType: declaration.mediaType,
    size: declaration.size,
    sha256: declaration.sha256,
    signature: testSignature,
    sbom: testSbom,
    storageKey: `releases/${releaseId}/${declaration.fileName}`,
    sbomStorageKey: `releases/${releaseId}/${testSbom.fileName}`,
  });
  await repository.finalizeArtifact(artifact.id, undefined);
  await repository.submitRelease(releaseId);
  const evidence = [
    {
      id: '22222222-2222-4222-8222-222222222222',
      validator: 'desktop-test-validator',
      check: 'digest' as const,
      outcome: 'passed' as const,
      observedAt: '2026-09-01T00:00:00.000Z',
      details: {},
    },
  ];
  await repository.applyValidationResult({
    releaseId,
    success: true,
    artifactIds: [artifact.id],
    releaseEvidence: evidence,
    artifactEvidence: { [artifact.id]: evidence },
  });
  await repository.createReview({
    releaseId,
    reviewerId,
    decision: 'approve',
    comment: 'Approved for desktop control-plane tests',
  });
}

function isDomainError(status: number, code: string) {
  return (error: unknown) => error instanceof DomainError && error.status === status && error.code === code;
}
