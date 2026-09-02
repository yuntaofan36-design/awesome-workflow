import assert from 'node:assert/strict';
import test from 'node:test';

import { PlatformRoleSchema, ReleaseStatusSchema, WorkspaceRoleSchema } from './index.js';

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
