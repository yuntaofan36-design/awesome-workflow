import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPlatformConfig } from '@awesome-workflow/config';
import { computeArtifactSetIntegritySha256 } from '@awesome-workflow/manifest-schema';

import { createApiApplication } from './bootstrap.js';
import {
  MemoryValidationQueueAdapter,
  VALIDATION_QUEUE,
} from './modules/control-plane/validation-queue.port.js';

const sha256 = 'a'.repeat(64);
const signature = { algorithm: 'ed25519' as const, keyId: 'publisher-test-key', value: 'A'.repeat(88) };
const sbom = {
  format: 'cyclonedx-json' as const,
  fileName: 'sbom.cdx.json',
  mediaType: 'application/vnd.cyclonedx+json' as const,
  sha256: 'b'.repeat(64),
};

test('Nest/Fastify API enforces auth, RBAC, immutable release review, promotion and catalog', async (context) => {
  const config = loadPlatformConfig({
    NODE_ENV: 'test',
    REPOSITORY_MODE: 'memory',
    AUTH_MODE: 'local_otp',
    AUTH_DEV_EXPOSE_OTP: 'true',
    SESSION_SECRET: 'test-session-secret-that-is-at-least-32-characters',
    OTP_PEPPER: 'test-otp-pepper-that-is-at-least-32-characters',
    WORKER_CALLBACK_TOKEN: 'test-worker-token-that-is-at-least-32-characters',
    BOOTSTRAP_ADMIN_EMAILS: 'reviewer@example.test',
    ARTIFACT_UPLOAD_BASE_URL: 'https://artifacts.example.test/bucket',
  });
  const app = await createApiApplication(config);
  context.after(() => app.close());
  const server = app.getHttpAdapter().getInstance();

  const openApi = await server.inject({ method: 'GET', url: '/api/v1/openapi.json' });
  assert.equal(openApi.statusCode, 200);
  assert.equal(openApi.json().openapi, '3.1.0');
  assert.ok(openApi.json().paths['/api/v1/releases/{releaseId}/submit']);
  assert.ok(openApi.json().paths['/api/v1/workspaces/{workspaceId}/releases']);
  assert.ok(openApi.json().paths['/api/v1/reviews']);

  const reviewer = await login(server, 'reviewer@example.test');
  assert.equal(reviewer.user.platformRoles.includes('platform_admin'), true);
  assert.equal('accessToken' in reviewer.user, false);
  assert.match(reviewer.setCookie, /HttpOnly/i);

  const sessionResponse = await server.inject({
    method: 'GET',
    url: '/api/v1/auth/session',
    cookies: { aw_session: reviewer.cookie },
  });
  assert.equal(sessionResponse.statusCode, 200);
  assert.equal(sessionResponse.json().data.email, 'reviewer@example.test');

  const workspacesResponse = await server.inject({
    method: 'GET',
    url: '/api/v1/workspaces',
    cookies: { aw_session: reviewer.cookie },
  });
  assert.equal(workspacesResponse.statusCode, 200);
  const workspace = workspacesResponse.json().data[0] as { id: string; role: string };
  assert.equal(workspace.role, 'owner');

  const applicationResponse = await server.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspace.id}/applications`,
    cookies: { aw_session: reviewer.cookie },
    payload: { slug: 'sample-web', name: 'Sample web', summary: 'End-to-end test', kind: 'web' },
  });
  assert.equal(applicationResponse.statusCode, 201);
  const application = applicationResponse.json().data as { id: string };

  const outsider = await login(server, 'outsider@example.test');
  const forbiddenResponse = await server.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${workspace.id}/applications`,
    cookies: { aw_session: outsider.cookie },
  });
  assert.equal(forbiddenResponse.statusCode, 403);
  assert.match(String(forbiddenResponse.headers['content-type']), /application\/problem\+json/);

  const artifactDeclaration = {
    name: 'web-bundle',
    fileName: 'web-bundle.zip',
    mediaType: 'application/zip',
    size: 1024,
    sha256,
  };
  const integrity = await computeArtifactSetIntegritySha256([artifactDeclaration]);
  const manifest = {
    schemaVersion: 1,
    appId: 'sample-web',
    version: '1.0.0',
    artifacts: [artifactDeclaration],
    integrity: { algorithm: 'sha256', digest: integrity },
    signature,
    kind: 'web',
    runtime: 'iframe',
    routeBase: '/sample-web',
    hostApiVersion: '1',
    capabilities: ['context.read'],
    url: 'https://sample.example.test/',
    allowedOrigin: 'https://sample.example.test',
    sandbox: ['allow-scripts'],
  };
  const releaseResponse = await server.inject({
    method: 'POST',
    url: `/api/v1/applications/${application.id}/releases`,
    cookies: { aw_session: reviewer.cookie },
    payload: { version: '1.0.0', manifest, signature, sbom },
  });
  assert.equal(releaseResponse.statusCode, 201, releaseResponse.body);
  const release = releaseResponse.json().data as { id: string; status: string };
  assert.equal(release.status, 'draft');

  const releaseList = await server.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${workspace.id}/releases?kind=web&status=draft`,
    cookies: { aw_session: reviewer.cookie },
  });
  assert.equal(releaseList.statusCode, 200, releaseList.body);
  assert.equal(releaseList.json().data[0].release.id, release.id);
  assert.equal(releaseList.json().data[0].artifactCount, 0);

  const forbiddenReleaseList = await server.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${workspace.id}/releases`,
    cookies: { aw_session: outsider.cookie },
  });
  assert.equal(forbiddenReleaseList.statusCode, 403);

  const duplicateRelease = await server.inject({
    method: 'POST',
    url: `/api/v1/applications/${application.id}/releases`,
    cookies: { aw_session: reviewer.cookie },
    payload: { version: '1.0.0', manifest, signature, sbom },
  });
  assert.equal(duplicateRelease.statusCode, 409);

  const artifactResponse = await server.inject({
    method: 'POST',
    url: `/api/v1/releases/${release.id}/artifacts`,
    cookies: { aw_session: reviewer.cookie },
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

  const uploadingStatus = await server.inject({
    method: 'GET',
    url: `/api/v1/releases/${release.id}/status`,
    cookies: { aw_session: reviewer.cookie },
  });
  assert.equal(uploadingStatus.json().data.release.status, 'uploading');

  assert.equal(
    (
      await server.inject({
        method: 'POST',
        url: `/api/v1/artifacts/${artifact.id}/finalize`,
        cookies: { aw_session: reviewer.cookie },
        payload: { etag: 'test-etag' },
      })
    ).statusCode,
    201,
  );

  const submitted = await server.inject({
    method: 'POST',
    url: `/api/v1/releases/${release.id}/submit`,
    cookies: { aw_session: reviewer.cookie },
  });
  assert.equal(submitted.statusCode, 200);
  assert.equal(submitted.json().data.release.status, 'validating');
  const validationQueue = app.get(VALIDATION_QUEUE) as MemoryValidationQueueAdapter;
  assert.equal(validationQueue.jobs.length, 1);
  assert.equal(validationQueue.jobs[0]?.artifacts[0]?.fileName, artifactDeclaration.fileName);
  assert.match(validationQueue.jobs[0]?.artifacts[0]?.sbom.url ?? '', /sbom\.cdx\.json/);

  const resubmitted = await server.inject({
    method: 'POST',
    url: `/api/v1/releases/${release.id}/submit`,
    cookies: { aw_session: reviewer.cookie },
  });
  assert.equal(resubmitted.statusCode, 200);
  assert.equal(validationQueue.jobs.length, 1);

  const evidence = {
    id: '11111111-1111-4111-8111-111111111111',
    validator: 'validation-worker',
    check: 'digest',
    outcome: 'passed',
    observedAt: '2026-09-01T00:00:00.000Z',
    details: {},
  };
  const validation = await server.inject({
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
          actualSize: 1024,
          evidence: [evidence],
        },
      ],
      releaseEvidence: [evidence],
    },
  });
  assert.equal(validation.statusCode, 200, validation.body);
  assert.equal(validation.json().data.release.status, 'ready');

  const pendingReviews = await server.inject({
    method: 'GET',
    url: `/api/v1/reviews?workspaceId=${workspace.id}&kind=web`,
    cookies: { aw_session: reviewer.cookie },
  });
  assert.equal(pendingReviews.statusCode, 200, pendingReviews.body);
  assert.equal(pendingReviews.json().data[0].release.id, release.id);
  assert.equal(pendingReviews.json().data[0].artifactCount, 1);

  const replayedValidation = await server.inject({
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
          actualSize: 1024,
          evidence: [evidence],
        },
      ],
      releaseEvidence: [evidence],
    },
  });
  assert.equal(replayedValidation.statusCode, 200, replayedValidation.body);

  const reviewed = await server.inject({
    method: 'POST',
    url: `/api/v1/releases/${release.id}/reviews`,
    cookies: { aw_session: reviewer.cookie },
    payload: { decision: 'approve', comment: 'Verified by test' },
  });
  assert.equal(reviewed.statusCode, 201, reviewed.body);
  assert.equal(reviewed.json().data.release.status, 'approved');

  const emptyReviewQueue = await server.inject({
    method: 'GET',
    url: `/api/v1/reviews?workspaceId=${workspace.id}&kind=web`,
    cookies: { aw_session: reviewer.cookie },
  });
  assert.equal(emptyReviewQueue.statusCode, 200, emptyReviewQueue.body);
  assert.deepEqual(emptyReviewQueue.json().data, []);

  const promoted = await server.inject({
    method: 'POST',
    url: `/api/v1/applications/${application.id}/channels/stable/promote`,
    cookies: { aw_session: reviewer.cookie },
    payload: { releaseId: release.id, expectedCurrentReleaseId: null },
  });
  assert.equal(promoted.statusCode, 200, promoted.body);

  const stalePromotion = await server.inject({
    method: 'POST',
    url: `/api/v1/applications/${application.id}/channels/stable/promote`,
    cookies: { aw_session: reviewer.cookie },
    payload: { releaseId: release.id, expectedCurrentReleaseId: null },
  });
  assert.equal(stalePromotion.statusCode, 409);

  const catalog = await server.inject({
    method: 'GET',
    url: `/api/v1/catalog?workspaceId=${workspace.id}&channel=stable&kind=web`,
    cookies: { aw_session: reviewer.cookie },
  });
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.equal(catalog.json().data[0].releaseId, release.id);

  const auditResponse = await server.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${workspace.id}/audit-events`,
    cookies: { aw_session: reviewer.cookie },
  });
  assert.equal(auditResponse.statusCode, 200, auditResponse.body);
  const auditActions = (auditResponse.json().data as Array<{ action: string }>).map(({ action }) => action);
  for (const action of ['application.created', 'release.created', 'release.reviewed', 'channel.promoted']) {
    assert.equal(auditActions.includes(action), true, `missing audit action ${action}`);
  }
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
  return {
    cookie: cookie.value as string,
    setCookie: String(verifyResponse.headers['set-cookie']),
    user: verifyResponse.json().data as { platformRoles: string[]; [key: string]: unknown },
  };
}
