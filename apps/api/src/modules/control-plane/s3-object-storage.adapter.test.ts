import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPlatformConfig } from '@awesome-workflow/config';

import { S3ObjectStorageAdapter } from './s3-object-storage.adapter.js';

test('S3 adapter signs public uploads and internal worker downloads without network access', async () => {
  const adapter = new S3ObjectStorageAdapter(
    loadPlatformConfig({
      NODE_ENV: 'test',
      OBJECT_STORAGE_MODE: 's3',
      S3_ENDPOINT: 'https://objects.internal.example.test',
      S3_PUBLIC_ENDPOINT: 'https://uploads.example.test',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'awesome-workflow-test',
      S3_ACCESS_KEY_ID: 'test-access-key',
      S3_SECRET_ACCESS_KEY: 'test-secret-key',
      S3_FORCE_PATH_STYLE: 'true',
    }),
  );
  const sha256 = 'a'.repeat(64);
  const upload = await adapter.createUpload({
    key: `objects/sha256/${sha256}/example.awpkg`,
    contentType: 'application/zip',
    sha256,
    size: 42,
  });
  const uploadUrl = new URL(upload.url);
  assert.equal(uploadUrl.origin, 'https://uploads.example.test');
  assert.match(uploadUrl.pathname, /awesome-workflow-test\/objects\/sha256/);
  assert.ok(uploadUrl.searchParams.get('X-Amz-Signature'));
  assert.equal(upload.headers['x-amz-meta-aw-sha256'], sha256);
  assert.equal(upload.headers['x-amz-checksum-sha256'], Buffer.from(sha256, 'hex').toString('base64'));

  const download = await adapter.createDownload('releases/release-id/example.awpkg');
  const downloadUrl = new URL(download.url);
  assert.equal(downloadUrl.origin, 'https://objects.internal.example.test');
  assert.ok(downloadUrl.searchParams.get('X-Amz-Signature'));
  assert.ok(Date.parse(download.expiresAt) > Date.now());
});
