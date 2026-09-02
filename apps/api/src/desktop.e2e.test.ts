import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPlatformConfig } from '@awesome-workflow/config';
import {
  computeArtifactSetIntegritySha256,
  computeDesktopCapabilityHash,
} from '@awesome-workflow/manifest-schema';

import { createApiApplication } from './bootstrap.js';

const sha256 = 'a'.repeat(64);
const signature = {
  algorithm: 'ed25519' as const,
  keyId: 'desktop-e2e-publisher-key',
  value: 'A'.repeat(88),
};
const sbom = {
  format: 'cyclonedx-json' as const,
  fileName: 'desktop-sbom.cdx.json',
  mediaType: 'application/vnd.cyclonedx+json' as const,
  sha256: 'b'.repeat(64),
};

test('desktop API enforces device ownership and drives install, schedule and run lifecycles', async (context) => {
  const config = loadPlatformConfig({
    NODE_ENV: 'test',
    REPOSITORY_MODE: 'memory',
    AUTH_MODE: 'local_otp',
    AUTH_DEV_EXPOSE_OTP: 'true',
    SESSION_SECRET: 'desktop-e2e-session-secret-at-least-32-characters',
    OTP_PEPPER: 'desktop-e2e-otp-pepper-at-least-32-characters',
    WORKER_CALLBACK_TOKEN: 'desktop-e2e-worker-token-at-least-32-characters',
    BOOTSTRAP_ADMIN_EMAILS: 'desktop-owner@example.test',
    ARTIFACT_UPLOAD_BASE_URL: 'https://artifacts.example.test/bucket',
  });
  const app = await createApiApplication(config);
  context.after(() => app.close());
  const server = app.getHttpAdapter().getInstance();
  const owner = await login(server, 'desktop-owner@example.test');
  const outsider = await login(server, 'desktop-outsider@example.test');

  const workspaceResponse = await server.inject({
    method: 'GET',
    url: '/api/v1/workspaces',
    cookies: { aw_session: owner.cookie },
  });
  assert.equal(workspaceResponse.statusCode, 200, workspaceResponse.body);
  const workspace = workspaceResponse.json().data[0] as { id: string };

  const deviceResponse = await server.inject({
    method: 'POST',
    url: '/api/v1/devices',
    cookies: { aw_session: owner.cookie },
    payload: {
      workspaceId: workspace.id,
      name: 'Desktop E2E workstation',
      os: 'windows',
      arch: 'x64',
      agentVersion: '1.0.0',
      publicKeyThumbprint: 'sha256:desktop-e2e-device-key',
    },
  });
  assert.equal(deviceResponse.statusCode, 201, deviceResponse.body);
  const registration = deviceResponse.json().data as {
    device: { id: string };
    credential: string;
  };
  const device = registration.device;
  assert.match(registration.credential, /^awd_[A-Za-z0-9_-]{43}$/);

  const rotatedRegistrationResponse = await server.inject({
    method: 'POST',
    url: '/api/v1/devices',
    cookies: { aw_session: owner.cookie },
    payload: {
      workspaceId: workspace.id,
      name: 'Desktop E2E workstation',
      os: 'windows',
      arch: 'x64',
      agentVersion: '1.0.0',
      publicKeyThumbprint: 'sha256:desktop-e2e-device-key',
    },
  });
  assert.equal(rotatedRegistrationResponse.statusCode, 201, rotatedRegistrationResponse.body);
  const rotatedRegistration = rotatedRegistrationResponse.json().data as {
    device: { id: string };
    credential: string;
  };
  assert.equal(rotatedRegistration.device.id, device.id);
  assert.notEqual(rotatedRegistration.credential, registration.credential);
  const rejectedPreviousCredential = await server.inject({
    method: 'GET',
    url: `/api/v1/devices/${device.id}/installations/sync?revision=0`,
    headers: { authorization: `Device ${registration.credential}` },
  });
  assert.equal(rejectedPreviousCredential.statusCode, 401, rejectedPreviousCredential.body);
  const deviceHeaders = { authorization: `Device ${rotatedRegistration.credential}` };

  const outsiderDevices = await server.inject({
    method: 'GET',
    url: `/api/v1/devices?workspaceId=${workspace.id}`,
    cookies: { aw_session: outsider.cookie },
  });
  assert.equal(outsiderDevices.statusCode, 403, outsiderDevices.body);

  const applicationResponse = await server.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspace.id}/applications`,
    cookies: { aw_session: owner.cookie },
    payload: {
      slug: 'desktop-e2e-runner',
      name: 'Desktop E2E runner',
      summary: 'Signed desktop micro-application used by the control-plane E2E test',
      kind: 'desktop',
    },
  });
  assert.equal(applicationResponse.statusCode, 201, applicationResponse.body);
  const application = applicationResponse.json().data as { id: string; slug: string };

  const artifactDeclaration = {
    name: 'windows-x64',
    fileName: 'desktop-e2e-runner-windows-x64.zip',
    mediaType: 'application/zip',
    size: 4_096,
    sha256,
    platform: { os: 'windows' as const, arch: 'x64' as const },
  };
  const integrity = await computeArtifactSetIntegritySha256([artifactDeclaration]);
  const manifest = {
    schemaVersion: 1 as const,
    appId: 'desktop-e2e-runner',
    version: '1.2.3',
    artifacts: [artifactDeclaration],
    integrity: { algorithm: 'sha256' as const, digest: integrity },
    signature,
    kind: 'desktop' as const,
    name: 'Desktop E2E runner',
    description: 'Exercises installation and runtime orchestration',
    runtimes: [
      {
        kind: 'native' as const,
        platform: { os: 'windows' as const, arch: 'x64' as const },
        artifact: artifactDeclaration.name,
        entry: 'bin/desktop-e2e-runner.exe',
      },
    ],
    dependencies: [],
    capabilities: [
      {
        kind: 'lifecycle' as const,
        actions: ['install' as const, 'update' as const],
        elevation: 'user-approved' as const,
      },
    ],
    runMode: 'serial' as const,
    minHostVersion: '1.0.0',
  };
  const releaseResponse = await server.inject({
    method: 'POST',
    url: `/api/v1/applications/${application.id}/releases`,
    cookies: { aw_session: owner.cookie },
    payload: { version: manifest.version, manifest, signature, sbom },
  });
  assert.equal(releaseResponse.statusCode, 201, releaseResponse.body);
  const release = releaseResponse.json().data as { id: string; version: string };

  const installationPayload = {
    workspaceId: workspace.id,
    deviceId: device.id,
    applicationId: application.id,
    releaseId: release.id,
  };
  const schedulePayload = {
    workspaceId: workspace.id,
    applicationId: application.id,
    releaseId: release.id,
    targetDeviceId: device.id,
    name: 'Desktop E2E nightly run',
    cronExpression: '0 2 * * *',
    timezone: 'Asia/Shanghai',
    nextRunAtMs: 1_800_000_000_000,
    input: { args: ['--scheduled'] },
  };
  const manualRunPayload = {
    workspaceId: workspace.id,
    deviceId: device.id,
    applicationId: application.id,
    releaseId: release.id,
    input: { args: ['--manual'] },
  };
  const unapprovedInstallation = await server.inject({
    method: 'POST',
    url: '/api/v1/installations',
    cookies: { aw_session: owner.cookie },
    payload: installationPayload,
  });
  assert.equal(unapprovedInstallation.statusCode, 409, unapprovedInstallation.body);

  const artifactResponse = await server.inject({
    method: 'POST',
    url: `/api/v1/releases/${release.id}/artifacts`,
    cookies: { aw_session: owner.cookie },
    payload: {
      fileName: artifactDeclaration.fileName,
      contentType: artifactDeclaration.mediaType,
      size: artifactDeclaration.size,
      sha256,
      signature,
      sbom,
    },
  });
  assert.equal(artifactResponse.statusCode, 201, artifactResponse.body);
  const artifact = artifactResponse.json().data.artifact as { id: string };
  assert.equal(
    (
      await server.inject({
        method: 'POST',
        url: `/api/v1/artifacts/${artifact.id}/finalize`,
        cookies: { aw_session: owner.cookie },
        payload: { etag: 'desktop-e2e-etag' },
      })
    ).statusCode,
    201,
  );
  assert.equal(
    (
      await server.inject({
        method: 'POST',
        url: `/api/v1/releases/${release.id}/submit`,
        cookies: { aw_session: owner.cookie },
      })
    ).statusCode,
    200,
  );

  const evidence = {
    id: '33333333-3333-4333-8333-333333333333',
    validator: 'desktop-e2e-validator',
    check: 'digest',
    outcome: 'passed',
    observedAt: '2026-09-01T00:00:00.000Z',
    details: {},
  };
  const validationResponse = await server.inject({
    method: 'POST',
    url: `/api/v1/internal/releases/${release.id}/validation-result`,
    headers: { authorization: `Bearer ${config.WORKER_CALLBACK_TOKEN}` },
    payload: {
      releaseId: release.id,
      success: true,
      artifactResults: [
        {
          artifactId: artifact.id,
          success: true,
          actualSha256: sha256,
          actualSize: artifactDeclaration.size,
          evidence: [evidence],
        },
      ],
      releaseEvidence: [evidence],
    },
  });
  assert.equal(validationResponse.statusCode, 200, validationResponse.body);
  const reviewResponse = await server.inject({
    method: 'POST',
    url: `/api/v1/releases/${release.id}/reviews`,
    cookies: { aw_session: owner.cookie },
    payload: { decision: 'approve', comment: 'Approved by desktop E2E' },
  });
  assert.equal(reviewResponse.statusCode, 201, reviewResponse.body);
  assert.equal(reviewResponse.json().data.release.status, 'approved');

  for (const [url, payload] of [
    ['/api/v1/installations', installationPayload],
    ['/api/v1/schedules', schedulePayload],
    ['/api/v1/runs', manualRunPayload],
  ] as const) {
    const denied = await server.inject({
      method: 'POST',
      url,
      cookies: { aw_session: owner.cookie },
      payload,
    });
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal(denied.json().code, 'permission_approval_required');
  }

  const requirementUrl = `/api/v1/devices/${device.id}/releases/${release.id}/permission-requirement`;
  const outsiderRequirement = await server.inject({
    method: 'GET',
    url: requirementUrl,
    cookies: { aw_session: outsider.cookie },
  });
  assert.equal(outsiderRequirement.statusCode, 403, outsiderRequirement.body);

  const requirementResponse = await server.inject({
    method: 'GET',
    url: requirementUrl,
    cookies: { aw_session: owner.cookie },
  });
  assert.equal(requirementResponse.statusCode, 200, requirementResponse.body);
  const requirement = requirementResponse.json().data as {
    workspaceId: string;
    deviceId: string;
    applicationId: string;
    releaseId: string;
    capabilities: typeof manifest.capabilities;
    capabilityHash: string;
    approvalRequired: boolean;
  };
  assert.deepEqual(requirement, {
    workspaceId: workspace.id,
    deviceId: device.id,
    applicationId: application.id,
    releaseId: release.id,
    capabilities: manifest.capabilities,
    capabilityHash: await computeDesktopCapabilityHash(manifest.capabilities),
    approvalRequired: true,
  });

  const wrongHashApproval = await server.inject({
    method: 'POST',
    url: `/api/v1/devices/${device.id}/permission-grants`,
    cookies: { aw_session: owner.cookie },
    payload: { releaseId: release.id, expectedCapabilityHash: '0'.repeat(64) },
  });
  assert.equal(wrongHashApproval.statusCode, 409, wrongHashApproval.body);
  assert.equal(wrongHashApproval.json().code, 'permission_requirement_changed');

  const clientDeclaredCapabilities = await server.inject({
    method: 'POST',
    url: `/api/v1/devices/${device.id}/permission-grants`,
    cookies: { aw_session: owner.cookie },
    payload: {
      releaseId: release.id,
      expectedCapabilityHash: requirement.capabilityHash,
      capabilities: [],
    },
  });
  assert.equal(clientDeclaredCapabilities.statusCode, 400, clientDeclaredCapabilities.body);
  assert.equal(clientDeclaredCapabilities.json().code, 'validation_failed');

  const outsiderApproval = await server.inject({
    method: 'POST',
    url: `/api/v1/devices/${device.id}/permission-grants`,
    cookies: { aw_session: outsider.cookie },
    payload: { releaseId: release.id, expectedCapabilityHash: requirement.capabilityHash },
  });
  assert.equal(outsiderApproval.statusCode, 403, outsiderApproval.body);

  const approvalResponse = await server.inject({
    method: 'POST',
    url: `/api/v1/devices/${device.id}/permission-grants`,
    cookies: { aw_session: owner.cookie },
    payload: { releaseId: release.id, expectedCapabilityHash: requirement.capabilityHash },
  });
  assert.equal(approvalResponse.statusCode, 201, approvalResponse.body);
  const grant = approvalResponse.json().data as {
    id: string;
    capabilityHash: string;
    capabilities: typeof manifest.capabilities;
    status: string;
  };
  assert.equal(grant.capabilityHash, requirement.capabilityHash);
  assert.deepEqual(grant.capabilities, manifest.capabilities);
  assert.equal(grant.status, 'active');

  const activeGrantList = await server.inject({
    method: 'GET',
    url: `/api/v1/permission-grants?workspaceId=${workspace.id}&deviceId=${device.id}&status=active`,
    cookies: { aw_session: owner.cookie },
  });
  assert.equal(activeGrantList.statusCode, 200, activeGrantList.body);
  assert.deepEqual(
    (activeGrantList.json().data as Array<{ id: string }>).map((candidate) => candidate.id),
    [grant.id],
  );

  const approvedRequirement = await server.inject({
    method: 'GET',
    url: requirementUrl,
    cookies: { aw_session: owner.cookie },
  });
  assert.equal(approvedRequirement.statusCode, 200, approvedRequirement.body);
  assert.equal(approvedRequirement.json().data.approvalRequired, false);

  const installationResponse = await server.inject({
    method: 'POST',
    url: '/api/v1/installations',
    cookies: { aw_session: owner.cookie },
    payload: installationPayload,
  });
  assert.equal(installationResponse.statusCode, 201, installationResponse.body);
  const installation = installationResponse.json().data as { id: string };

  const installationSnapshotResponse = await server.inject({
    method: 'GET',
    url: `/api/v1/devices/${device.id}/installations/sync?revision=0`,
    headers: deviceHeaders,
  });
  assert.equal(installationSnapshotResponse.statusCode, 200, installationSnapshotResponse.body);
  const installationSync = installationSnapshotResponse.json().data as {
    kind: string;
    snapshot: {
      revision: number;
      installations: Array<{
        installationId: string;
        status: string;
        appId: string;
        version: string;
        manifest: typeof manifest;
        artifact: {
          size: number;
          sha256: string;
          downloadUrl: string;
          downloadExpiresAt: string;
          attestation: typeof signature;
        };
      }>;
    };
  };
  assert.equal(installationSync.kind, 'snapshot');
  assert.equal(installationSync.snapshot.revision, 1);
  assert.deepEqual(installationSync.snapshot.installations[0], {
    installationId: installation.id,
    status: 'requested',
    appId: application.slug,
    version: release.version,
    manifest,
    artifact: {
      name: artifactDeclaration.name,
      fileName: artifactDeclaration.fileName,
      mediaType: artifactDeclaration.mediaType,
      size: artifactDeclaration.size,
      sha256,
      downloadUrl: `https://artifacts.example.test/bucket/objects/sha256/${sha256}/${artifactDeclaration.fileName}`,
      downloadExpiresAt: installationSync.snapshot.installations[0]!.artifact.downloadExpiresAt,
      attestation: signature,
    },
  });
  assert.equal(
    Number.isNaN(Date.parse(installationSync.snapshot.installations[0]!.artifact.downloadExpiresAt)),
    false,
  );
  const unchangedInstallations = await server.inject({
    method: 'GET',
    url: `/api/v1/devices/${device.id}/installations/sync?revision=1`,
    headers: deviceHeaders,
  });
  assert.equal(unchangedInstallations.statusCode, 200, unchangedInstallations.body);
  assert.deepEqual(unchangedInstallations.json().data, { kind: 'unchanged', revision: 1 });
  const aheadInstallationRevision = await server.inject({
    method: 'GET',
    url: `/api/v1/devices/${device.id}/installations/sync?revision=2`,
    headers: deviceHeaders,
  });
  assert.equal(aheadInstallationRevision.statusCode, 409, aheadInstallationRevision.body);
  assert.equal(aheadInstallationRevision.json().code, 'installation_revision_ahead');

  const invalidInstallationTransition = await server.inject({
    method: 'POST',
    url: `/api/v1/devices/${device.id}/installations/${installation.id}/status`,
    headers: deviceHeaders,
    payload: { status: 'installed' },
  });
  assert.equal(invalidInstallationTransition.statusCode, 409, invalidInstallationTransition.body);
  for (const status of ['downloading', 'installed']) {
    const statusResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/devices/${device.id}/installations/${installation.id}/status`,
      headers: deviceHeaders,
      payload: { status },
    });
    assert.equal(statusResponse.statusCode, 200, statusResponse.body);
    assert.equal(statusResponse.json().data.status, status);
  }

  const scheduleResponse = await server.inject({
    method: 'POST',
    url: '/api/v1/schedules',
    cookies: { aw_session: owner.cookie },
    payload: schedulePayload,
  });
  assert.equal(scheduleResponse.statusCode, 201, scheduleResponse.body);
  const schedule = scheduleResponse.json().data as { id: string; revision: number };
  assert.equal(schedule.revision, 1);

  const humanSessionCannotImpersonateDevice = await server.inject({
    method: 'GET',
    url: `/api/v1/devices/${device.id}/schedules/sync`,
    cookies: { aw_session: owner.cookie },
  });
  assert.equal(humanSessionCannotImpersonateDevice.statusCode, 401);

  const snapshotResponse = await server.inject({
    method: 'GET',
    url: `/api/v1/devices/${device.id}/schedules/sync`,
    headers: deviceHeaders,
  });
  assert.equal(snapshotResponse.statusCode, 200, snapshotResponse.body);
  assert.equal(snapshotResponse.json().data.kind, 'snapshot');
  assert.deepEqual(snapshotResponse.json().data.snapshot.schedules[0].args, ['--scheduled']);

  const updateScheduleResponse = await server.inject({
    method: 'PATCH',
    url: `/api/v1/schedules/${schedule.id}`,
    cookies: { aw_session: owner.cookie },
    payload: { expectedRevision: 1, input: { args: ['--updated'] } },
  });
  assert.equal(updateScheduleResponse.statusCode, 200, updateScheduleResponse.body);
  assert.equal(updateScheduleResponse.json().data.revision, 2);
  const staleScheduleResponse = await server.inject({
    method: 'PATCH',
    url: `/api/v1/schedules/${schedule.id}`,
    cookies: { aw_session: owner.cookie },
    payload: { expectedRevision: 1, name: 'Stale update' },
  });
  assert.equal(staleScheduleResponse.statusCode, 409, staleScheduleResponse.body);
  assert.equal(staleScheduleResponse.json().code, 'schedule_changed');

  const deltaResponse = await server.inject({
    method: 'GET',
    url: `/api/v1/devices/${device.id}/schedules/sync?revision=1`,
    headers: deviceHeaders,
  });
  assert.equal(deltaResponse.statusCode, 200, deltaResponse.body);
  assert.equal(deltaResponse.json().data.kind, 'delta');
  assert.equal(deltaResponse.json().data.delta.toRevision, 2);
  assert.deepEqual(deltaResponse.json().data.delta.upserts[0].args, ['--updated']);

  const runResponse = await server.inject({
    method: 'POST',
    url: '/api/v1/runs',
    cookies: { aw_session: owner.cookie },
    payload: manualRunPayload,
  });
  assert.equal(runResponse.statusCode, 201, runResponse.body);
  const run = runResponse.json().data as { id: string };

  const claimResponse = await server.inject({
    method: 'POST',
    url: `/api/v1/devices/${device.id}/runs/claim`,
    headers: deviceHeaders,
    payload: { limit: 1 },
  });
  assert.equal(claimResponse.statusCode, 200, claimResponse.body);
  assert.deepEqual(claimResponse.json().data[0], {
    runId: run.id,
    attempt: 1,
    appId: 'desktop-e2e-runner',
    version: '1.2.3',
    args: ['--manual'],
    requiresElevation: true,
  });

  for (const report of [
    { status: 'needs_user_approval', errorCode: 'elevation_required' },
    { status: 'running' },
    { status: 'succeeded', result: { exitCode: 0 } },
  ]) {
    const reportResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/devices/${device.id}/runs/${run.id}/report`,
      headers: deviceHeaders,
      payload: { attempt: 1, ...report },
    });
    assert.equal(reportResponse.statusCode, 200, reportResponse.body);
    assert.equal(reportResponse.json().data.status, report.status);
  }

  const replayedCompletion = await server.inject({
    method: 'POST',
    url: `/api/v1/devices/${device.id}/runs/${run.id}/report`,
    headers: deviceHeaders,
    payload: { attempt: 1, status: 'succeeded', result: { exitCode: 0 } },
  });
  assert.equal(replayedCompletion.statusCode, 200, replayedCompletion.body);
  const mismatchedReplay = await server.inject({
    method: 'POST',
    url: `/api/v1/devices/${device.id}/runs/${run.id}/report`,
    headers: deviceHeaders,
    payload: { attempt: 1, status: 'succeeded', result: { exitCode: 1 } },
  });
  assert.equal(mismatchedReplay.statusCode, 409, mismatchedReplay.body);
  assert.equal(mismatchedReplay.json().code, 'run_report_mismatch');

  const cancellableRunResponse = await server.inject({
    method: 'POST',
    url: '/api/v1/runs',
    cookies: { aw_session: owner.cookie },
    payload: {
      workspaceId: workspace.id,
      deviceId: device.id,
      applicationId: application.id,
      releaseId: release.id,
      input: { args: ['--cancel-me'] },
    },
  });
  assert.equal(cancellableRunResponse.statusCode, 201, cancellableRunResponse.body);
  const cancellableRun = cancellableRunResponse.json().data as { id: string };
  const cancellableClaim = await server.inject({
    method: 'POST',
    url: `/api/v1/devices/${device.id}/runs/claim`,
    headers: deviceHeaders,
    payload: { limit: 1 },
  });
  assert.equal(cancellableClaim.statusCode, 200, cancellableClaim.body);
  assert.equal(cancellableClaim.json().data[0].runId, cancellableRun.id);

  const cancelRequest = await server.inject({
    method: 'POST',
    url: `/api/v1/runs/${cancellableRun.id}/cancel`,
    cookies: { aw_session: owner.cookie },
  });
  assert.equal(cancelRequest.statusCode, 200, cancelRequest.body);
  assert.equal(cancelRequest.json().data.status, 'dispatched');
  assert.match(cancelRequest.json().data.cancelRequestedAt, /^2026-|^20\d\d-/);

  const controlResponse = await server.inject({
    method: 'GET',
    url: `/api/v1/devices/${device.id}/runs/control`,
    headers: deviceHeaders,
  });
  assert.equal(controlResponse.statusCode, 200, controlResponse.body);
  assert.deepEqual(controlResponse.json().data, [
    {
      runId: cancellableRun.id,
      attempt: 1,
      cancelRequestedAt: cancelRequest.json().data.cancelRequestedAt,
    },
  ]);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cancelledReport = await server.inject({
      method: 'POST',
      url: `/api/v1/devices/${device.id}/runs/${cancellableRun.id}/report`,
      headers: deviceHeaders,
      payload: { attempt: 1, status: 'cancelled', errorCode: 'cancelled_by_user' },
    });
    assert.equal(cancelledReport.statusCode, 200, cancelledReport.body);
    assert.equal(cancelledReport.json().data.status, 'cancelled');
  }
  const emptyControl = await server.inject({
    method: 'GET',
    url: `/api/v1/devices/${device.id}/runs/control`,
    headers: deviceHeaders,
  });
  assert.equal(emptyControl.statusCode, 200, emptyControl.body);
  assert.deepEqual(emptyControl.json().data, []);

  const outsiderRuns = await server.inject({
    method: 'GET',
    url: `/api/v1/runs?workspaceId=${workspace.id}`,
    cookies: { aw_session: outsider.cookie },
  });
  assert.equal(outsiderRuns.statusCode, 403, outsiderRuns.body);

  const queuedBeforeRevocationResponse = await server.inject({
    method: 'POST',
    url: '/api/v1/runs',
    cookies: { aw_session: owner.cookie },
    payload: { ...manualRunPayload, input: { args: ['--revoked-before-claim'] } },
  });
  assert.equal(queuedBeforeRevocationResponse.statusCode, 201, queuedBeforeRevocationResponse.body);
  const queuedBeforeRevocation = queuedBeforeRevocationResponse.json().data as { id: string };

  const outsiderRevoke = await server.inject({
    method: 'POST',
    url: `/api/v1/permission-grants/${grant.id}/revoke`,
    cookies: { aw_session: outsider.cookie },
  });
  assert.equal(outsiderRevoke.statusCode, 403, outsiderRevoke.body);
  const grantRevoke = await server.inject({
    method: 'POST',
    url: `/api/v1/permission-grants/${grant.id}/revoke`,
    cookies: { aw_session: owner.cookie },
  });
  assert.equal(grantRevoke.statusCode, 200, grantRevoke.body);
  assert.equal(grantRevoke.json().data.status, 'revoked');

  const claimAfterRevocation = await server.inject({
    method: 'POST',
    url: `/api/v1/devices/${device.id}/runs/claim`,
    headers: deviceHeaders,
    payload: { limit: 1 },
  });
  assert.equal(claimAfterRevocation.statusCode, 200, claimAfterRevocation.body);
  assert.deepEqual(claimAfterRevocation.json().data, []);
  const revokedRunResponse = await server.inject({
    method: 'GET',
    url: `/api/v1/runs/${queuedBeforeRevocation.id}`,
    cookies: { aw_session: owner.cookie },
  });
  assert.equal(revokedRunResponse.statusCode, 200, revokedRunResponse.body);
  assert.equal(revokedRunResponse.json().data.status, 'failed');
  assert.equal(revokedRunResponse.json().data.errorCode, 'permission_grant_inactive');

  const revokedScheduleDelta = await server.inject({
    method: 'GET',
    url: `/api/v1/devices/${device.id}/schedules/sync?revision=2`,
    headers: deviceHeaders,
  });
  assert.equal(revokedScheduleDelta.statusCode, 200, revokedScheduleDelta.body);
  assert.equal(revokedScheduleDelta.json().data.kind, 'delta');
  assert.deepEqual(revokedScheduleDelta.json().data.delta.removedScheduleIds, [schedule.id]);

  for (const [url, payload] of [
    ['/api/v1/installations', installationPayload],
    ['/api/v1/schedules', { ...schedulePayload, name: 'Revoked schedule' }],
    ['/api/v1/runs', manualRunPayload],
  ] as const) {
    const denied = await server.inject({
      method: 'POST',
      url,
      cookies: { aw_session: owner.cookie },
      payload,
    });
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal(denied.json().code, 'permission_approval_required');
  }

  const auditResponse = await server.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${workspace.id}/audit-events`,
    cookies: { aw_session: owner.cookie },
  });
  assert.equal(auditResponse.statusCode, 200, auditResponse.body);
  const auditActions = (auditResponse.json().data as Array<{ action: string }>).map((event) => event.action);
  assert.equal(auditActions.includes('installation.requested'), true);
  assert.equal(auditActions.includes('schedule.updated'), true);
  assert.equal(auditActions.includes('run.status_reported'), true);
  assert.equal(auditActions.includes('permission_grant.approved'), true);
  assert.equal(auditActions.includes('permission_grant.revoked'), true);

  const revokeResponse = await server.inject({
    method: 'POST',
    url: `/api/v1/devices/${device.id}/revoke`,
    cookies: { aw_session: owner.cookie },
  });
  assert.equal(revokeResponse.statusCode, 200, revokeResponse.body);
  const revokedSync = await server.inject({
    method: 'GET',
    url: `/api/v1/devices/${device.id}/schedules/sync?revision=2`,
    headers: deviceHeaders,
  });
  assert.equal(revokedSync.statusCode, 401, revokedSync.body);
});

async function login(server: { inject(options: Record<string, unknown>): Promise<any> }, email: string) {
  const challengeResponse = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/email/challenges',
    payload: { email },
  });
  assert.equal(challengeResponse.statusCode, 200, challengeResponse.body);
  const challenge = challengeResponse.json().data as { challengeId: string; devCode: string };
  const verifyResponse = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/email/verify',
    payload: { challengeId: challenge.challengeId, code: challenge.devCode },
  });
  assert.equal(verifyResponse.statusCode, 200, verifyResponse.body);
  const cookie = verifyResponse.cookies.find(
    (candidate: { name: string }) => candidate.name === 'aw_session',
  );
  assert.ok(cookie?.value);
  return { cookie: cookie.value as string };
}
