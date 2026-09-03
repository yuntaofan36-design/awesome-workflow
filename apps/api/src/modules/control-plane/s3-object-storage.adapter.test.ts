import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPlatformConfig } from '@awesome-workflow/config';

import { S3ObjectStorageAdapter } from './s3-object-storage.adapter.js';

test('S3 adapter separates browser/device and internal Worker download audiences', async () => {
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
  assert.equal(uploadUrl.searchParams.has('x-amz-checksum-sha256'), false);
  assert.equal(uploadUrl.searchParams.has('x-amz-meta-aw-sha256'), false);
  const signedHeaders = uploadUrl.searchParams.get('X-Amz-SignedHeaders')?.split(';') ?? [];
  assert.ok(signedHeaders.includes('x-amz-checksum-sha256'));
  assert.ok(signedHeaders.includes('x-amz-meta-aw-sha256'));
  assert.equal(upload.headers['x-amz-meta-aw-sha256'], sha256);
  assert.equal(upload.headers['x-amz-checksum-sha256'], Buffer.from(sha256, 'hex').toString('base64'));

  const workerDownload = await adapter.createWorkerDownload('releases/release-id/example.awpkg');
  const workerDownloadUrl = new URL(workerDownload.url);
  assert.equal(workerDownloadUrl.origin, 'https://objects.internal.example.test');
  assert.ok(workerDownloadUrl.searchParams.get('X-Amz-Signature'));
  assert.ok(Date.parse(workerDownload.expiresAt) > Date.now());

  const deviceDownload = await adapter.createDeviceDownload('releases/release-id/example.awpkg');
  const deviceDownloadUrl = new URL(deviceDownload.url);
  assert.equal(deviceDownloadUrl.origin, 'https://uploads.example.test');
  assert.ok(deviceDownloadUrl.searchParams.get('X-Amz-Signature'));
  assert.ok(Date.parse(deviceDownload.expiresAt) > Date.now());
  assert.notEqual(workerDownloadUrl.origin, deviceDownloadUrl.origin);
});
