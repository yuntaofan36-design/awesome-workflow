import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiProblemError,
  createWebApplication,
  getReleaseStatus,
  listApplications,
  listPendingReviews,
  listReleases,
  reviewRelease,
} from './api';

const RELEASE_ID = '11111111-1111-4111-8111-111111111111';
const APPLICATION_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const ARTIFACT_ID = '44444444-4444-4444-8444-444444444444';
const digest = 'a'.repeat(64);
const signature = { algorithm: 'ed25519', keyId: 'publisher-2026', value: 's'.repeat(64) } as const;
const sbom = {
  fileName: 'sbom.cdx.json',
  format: 'cyclonedx-json',
  mediaType: 'application/vnd.cyclonedx+json',
  sha256: 'b'.repeat(64),
} as const;

const statusView = {
  artifacts: [
    {
      contentType: 'application/zip',
      createdAt: '2026-09-01T00:00:00.000Z',
      fileName: 'web-bundle.zip',
      finalizedAt: '2026-09-01T00:01:00.000Z',
      id: ARTIFACT_ID,
      releaseId: RELEASE_ID,
      sbom,
      sbomStorageKey: 'releases/release/sbom/sbom.cdx.json',
      sha256: digest,
      signature,
      size: 1024,
      status: 'validated',
      storageKey: 'releases/release/artifacts/web-bundle.zip',
      validationEvidence: [],
    },
  ],
  release: {
    applicationId: APPLICATION_ID,
    createdAt: '2026-09-01T00:00:00.000Z',
    createdBy: USER_ID,
    id: RELEASE_ID,
    manifest: {
      appId: 'sample-web',
      artifacts: [
        {
          fileName: 'web-bundle.zip',
          mediaType: 'application/zip',
          name: 'web-bundle',
          sha256: digest,
          size: 1024,
        },
      ],
      capabilities: [],
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: [],
      },
      hostApiVersion: '1',
      integrity: { algorithm: 'sha256', digest },
      kind: 'web',
      allowedOrigin: 'https://apps.example.test',
      routeBase: '/sample-web',
      runtime: 'iframe',
      sandbox: ['allow-scripts'],
      schemaVersion: 1,
      signature,
      trustTier: 'isolated',
      url: 'https://apps.example.test/sample-web',
      version: '1.0.0',
    },
    manifestSha256: digest,
    sbom,
    signature,
    status: 'ready',
    validationEvidence: [],
    version: '1.0.0',
  },
  reviews: [],
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('release control-plane API', () => {
  it('lists registered applications even before channel promotion', async () => {
    const workspaceId = '66666666-6666-4666-8666-666666666666';
    const application = {
      id: APPLICATION_ID,
      workspaceId,
      slug: 'sample-web',
      name: 'Sample web',
      summary: 'A sample application',
      defaultLocale: 'en-US',
      localizations: {},
      kind: 'web',
      createdAt: '2026-09-01T00:00:00.000Z',
    } as const;
    const fetchMock = vi.fn().mockResolvedValue(json({ data: [application] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listApplications(workspaceId, 'zh-CN')).resolves.toEqual([application]);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/workspaces/${workspaceId}/applications`,
      expect.objectContaining({ credentials: 'include' }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('accept-language')).toBe('zh-CN');
  });

  it('lists immutable releases and the server-backed pending review queue', async () => {
    const item = {
      application: {
        id: APPLICATION_ID,
        workspaceId: '66666666-6666-4666-8666-666666666666',
        slug: 'sample-web',
        name: 'Sample web',
        summary: 'A sample application',
        defaultLocale: 'en-US',
        localizations: {},
        kind: 'web',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
      release: statusView.release,
      artifactCount: 1,
      reviewCount: 0,
    } as const;
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json({ data: [item] })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listReleases(item.application.workspaceId, { kind: 'web' })).resolves.toEqual([item]);
    await expect(listPendingReviews(item.application.workspaceId, 'web')).resolves.toEqual([item]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/v1/workspaces/${item.application.workspaceId}/releases?kind=web`,
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/reviews?workspaceId=${item.application.workspaceId}&kind=web`,
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('loads the authoritative status by exact release ID', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: statusView }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getReleaseStatus(RELEASE_ID);

    expect(result.release.status).toBe('ready');
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/releases/${RELEASE_ID}/status`,
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('records a real review decision and never calls channel promotion', async () => {
    const reviewed = {
      ...statusView,
      release: { ...statusView.release, status: 'approved' },
      reviews: [
        {
          comment: 'Evidence verified',
          createdAt: '2026-09-01T00:02:00.000Z',
          decision: 'approve',
          id: '55555555-5555-4555-8555-555555555555',
          releaseId: RELEASE_ID,
          reviewerId: USER_ID,
        },
      ],
    } as const;
    const fetchMock = vi.fn().mockResolvedValue(json({ data: reviewed }, 201));
    vi.stubGlobal('fetch', fetchMock);

    const result = await reviewRelease({
      releaseId: RELEASE_ID,
      decision: 'approve',
      comment: 'Evidence verified',
    });

    expect(result.release.status).toBe('approved');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/releases/${RELEASE_ID}/reviews`,
      expect.objectContaining({
        body: JSON.stringify({ decision: 'approve', comment: 'Evidence verified' }),
        credentials: 'include',
        method: 'POST',
      }),
    );
  });

  it('uses the publisher-selected default locale instead of the current UI locale', async () => {
    const workspaceId = '66666666-6666-4666-8666-666666666666';
    const fetchMock = vi.fn().mockResolvedValue(new Response(undefined, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await createWebApplication({
      defaultLocale: 'zh-CN',
      locale: 'en-US',
      localizations: { 'en-US': { name: 'Sample web' } },
      name: '示例应用',
      slug: 'sample-web',
      summary: '示例简介',
      workspaceId,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      defaultLocale: 'zh-CN',
      kind: 'web',
      localizations: { 'en-US': { name: 'Sample web' } },
      name: '示例应用',
      slug: 'sample-web',
      summary: '示例简介',
    });
    expect((init.headers as Headers).get('accept-language')).toBe('en-US');
  });

  it('preserves RFC Problem Details and its stable error code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(
        {
          code: 'forbidden',
          detail: 'Server-side fallback detail',
          status: 403,
          title: 'Forbidden',
          type: 'https://awesome-workflow.dev/problems/forbidden',
        },
        403,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const error = await getReleaseStatus(RELEASE_ID, 'zh-CN').catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiProblemError);
    expect(error).toMatchObject({
      code: 'forbidden',
      problem: expect.objectContaining({ detail: 'Server-side fallback detail' }),
      status: 403,
    });
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}
