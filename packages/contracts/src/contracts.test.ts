import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApplicationSchema,
  CreateArtifactInputSchema,
  CreateReleaseInputSchema,
  InstallationSyncArtifactSchema,
  PlatformRoleSchema,
  ReleaseValidationJobSchema,
  ReleaseStatusSchema,
  SupportedLocaleSchema,
  WorkspaceRoleSchema,
} from './index.js';

test('workspace and platform roles are separate authority domains', () => {
  assert.deepEqual(WorkspaceRoleSchema.options, ['owner', 'admin', 'developer', 'member']);
  assert.deepEqual(PlatformRoleSchema.options, ['platform_admin', 'official_reviewer']);
  assert.equal(WorkspaceRoleSchema.safeParse('reviewer').success, false);
  assert.equal(PlatformRoleSchema.safeParse('admin').success, false);
});

test('desktop publication contracts omit publisher signatures while retaining immutable digests', () => {
  const artifact = {
    name: 'windows-x64',
    fileName: 'desktop-app.awpkg',
    mediaType: 'application/zip',
    size: 1024,
    sha256: 'a'.repeat(64),
    platform: { os: 'windows' as const, arch: 'x64' as const },
  };
  const manifest = {
    schemaVersion: 1 as const,
    appId: 'desktop-app',
    version: '1.0.0',
    artifacts: [artifact],
    integrity: { algorithm: 'sha256' as const, digest: 'b'.repeat(64) },
    kind: 'desktop' as const,
    name: 'Desktop app',
    description: 'Unsigned publisher metadata with immutable platform artifacts',
    runtimes: [
      {
        kind: 'native' as const,
        platform: artifact.platform,
        artifact: artifact.name,
        entry: 'app.exe',
      },
    ],
    dependencies: [],
    capabilities: [],
    runMode: 'singleton' as const,
    minHostVersion: '1.0.0',
  };
  const sbom = {
    format: 'cyclonedx-json' as const,
    fileName: 'desktop-app.cdx.json',
    mediaType: 'application/vnd.cyclonedx+json' as const,
    sha256: 'c'.repeat(64),
  };

  assert.equal(
    CreateReleaseInputSchema.safeParse({ version: manifest.version, manifest, sbom }).success,
    true,
  );
  assert.equal(
    CreateArtifactInputSchema.safeParse({
      fileName: artifact.fileName,
      contentType: artifact.mediaType,
      size: artifact.size,
      sha256: artifact.sha256,
      sbom,
    }).success,
    true,
  );
  assert.equal(
    ReleaseValidationJobSchema.safeParse({
      releaseId: '00000000-0000-4000-8000-000000000003',
      manifest,
      artifacts: [
        {
          artifactId: '00000000-0000-4000-8000-000000000004',
          fileName: artifact.fileName,
          url: 'https://objects.example.test/desktop-app.awpkg',
          expectedSha256: artifact.sha256,
          expectedSize: artifact.size,
          sbom: { ...sbom, url: 'https://objects.example.test/desktop-app.cdx.json' },
        },
      ],
    }).success,
    true,
  );
  assert.equal(
    InstallationSyncArtifactSchema.safeParse({
      ...artifact,
      downloadUrl: 'https://objects.example.test/desktop-app.awpkg',
      downloadExpiresAt: '2026-09-04T12:00:00.000Z',
    }).success,
    true,
  );
});

test('release state vocabulary matches the immutable publication workflow', () => {
  assert.deepEqual(ReleaseStatusSchema.options, [
    'draft',
    'uploading',
    'validating',
    'ready',
    'approved',
    'rejected',
  ]);
});

test('platform locales are explicit and application content keeps a canonical fallback', () => {
  assert.deepEqual(SupportedLocaleSchema.options, ['en-US', 'zh-CN']);
  const application = ApplicationSchema.parse({
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    slug: 'localized-app',
    name: 'Canonical name',
    summary: 'Canonical summary',
    kind: 'web',
    createdAt: '2026-09-02T00:00:00.000Z',
  });
  assert.equal(application.defaultLocale, 'en-US');
  assert.deepEqual(application.localizations, {});
});
