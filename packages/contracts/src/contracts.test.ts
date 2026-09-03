import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApplicationSchema,
  PlatformRoleSchema,
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
