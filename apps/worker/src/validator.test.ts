import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import yazl from 'yazl';

import {
  canonicalizeManifestForSignature,
  computeArtifactSetIntegritySha256,
} from '@awesome-workflow/manifest-schema';

import { loadWorkerConfig, parseSigningKeys } from './config.js';
import {
  assertSafeArchivePath,
  inspectZipArchive,
  validateSbomDocument,
  validateRelease,
  verifyPublisherSignature,
} from './validator.js';

test('publisher signatures are verified with the configured key id', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const digest = Buffer.alloc(32, 7);
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const keys = parseSigningKeys(JSON.stringify({ publisher: rawPublicKey.toString('base64') }));
  verifyPublisherSignature(
    digest,
    { algorithm: 'ed25519', keyId: 'publisher', value: sign(null, digest, privateKey).toString('base64') },
    keys,
  );
  assert.throws(
    () =>
      verifyPublisherSignature(
        Buffer.alloc(32, 8),
        {
          algorithm: 'ed25519',
          keyId: 'publisher',
          value: sign(null, digest, privateKey).toString('base64'),
        },
        keys,
      ),
    /verification failed/,
  );
});

test('archive paths reject traversal, alternate streams and device names', () => {
  for (const unsafe of [
    '../escape.txt',
    '/absolute.txt',
    'C:/drive.txt',
    'safe/../escape',
    'safe/file:stream',
    'CON',
    'folder/NUL.txt',
    'tail.',
  ]) {
    assert.throws(() => assertSafeArchivePath(unsafe));
  }
  assert.doesNotThrow(() => assertSafeArchivePath('payload/bin/tool.exe'));
});

test('archive inspection enforces expanded limits without extracting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aw-worker-test-'));
  const archivePath = join(directory, 'safe.awpkg');
  try {
    await writeZip(archivePath, [
      ['applet.json', Buffer.from('{}')],
      ['payload/main.py', Buffer.from('print("ok")')],
    ]);
    const summary = await inspectZipArchive(archivePath, { maxExpandedBytes: 1024, maxFiles: 5 });
    assert.equal(summary.files, 2);
    await assert.rejects(
      inspectZipArchive(archivePath, { maxExpandedBytes: 4, maxFiles: 5 }),
      /expanded-size limit/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SBOM parser distinguishes CycloneDX and SPDX JSON', () => {
  assert.doesNotThrow(() => validateSbomDocument(Buffer.from('{"bomFormat":"CycloneDX"}'), 'cyclonedx-json'));
  assert.doesNotThrow(() => validateSbomDocument(Buffer.from('{"spdxVersion":"SPDX-2.3"}'), 'spdx-json'));
  assert.throws(() => validateSbomDocument(Buffer.from('{"bomFormat":"other"}'), 'cyclonedx-json'));
  assert.throws(() => validateSbomDocument(Buffer.from('not-json'), 'spdx-json'));
});

test('release validation binds manifest, artifact, SBOM and archive evidence', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'aw-worker-release-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const archivePath = join(directory, 'sample.awpkg');
  await writeZip(archivePath, [['payload/main.py', Buffer.from('print("ok")')]]);
  const artifactBytes = await readFile(archivePath);
  const artifactSha256 = createHash('sha256').update(artifactBytes).digest('hex');
  const sbomBytes = Buffer.from('{"bomFormat":"CycloneDX","specVersion":"1.6"}');
  const sbomSha256 = createHash('sha256').update(sbomBytes).digest('hex');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const signatureIdentity = {
    algorithm: 'ed25519' as const,
    keyId: 'publisher',
    value: 'A'.repeat(88),
  };
  const artifactDeclaration = {
    name: 'windows-x64',
    fileName: 'sample.awpkg',
    mediaType: 'application/zip',
    size: artifactBytes.length,
    sha256: artifactSha256,
    platform: { os: 'windows' as const, arch: 'x64' as const },
  };
  const manifest = {
    schemaVersion: 1 as const,
    appId: 'sample-desktop',
    version: '1.0.0',
    artifacts: [artifactDeclaration],
    integrity: {
      algorithm: 'sha256' as const,
      digest: await computeArtifactSetIntegritySha256([artifactDeclaration]),
    },
    signature: signatureIdentity,
    kind: 'desktop' as const,
    name: 'Sample desktop',
    description: 'Worker integration fixture',
    runtimes: [
      {
        kind: 'python' as const,
        platform: { os: 'windows' as const, arch: 'x64' as const },
        artifact: 'windows-x64',
        entry: 'payload/main.py',
        python: '3.12',
      },
    ],
    dependencies: [],
    capabilities: [],
    runMode: 'serial' as const,
    minHostVersion: '0.1.0',
  };
  manifest.signature.value = sign(
    null,
    Buffer.from(canonicalizeManifestForSignature(manifest), 'utf8'),
    privateKey,
  ).toString('base64');

  const server = createServer((request, response) => {
    if (request.url === '/sample.awpkg') {
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': artifactBytes.length });
      response.end(artifactBytes);
      return;
    }
    if (request.url === '/sample.sbom.json') {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': sbomBytes.length });
      response.end(sbomBytes);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(
    () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const config = loadWorkerConfig({
    REDIS_URL: 'redis://127.0.0.1:6379',
    WORKER_API_BASE_URL: 'http://127.0.0.1:4100',
    WORKER_CALLBACK_TOKEN: 'test-worker-callback-token-at-least-32-characters',
    RELEASE_SIGNING_PUBLIC_KEYS: JSON.stringify({ publisher: rawPublicKey.toString('base64') }),
    ARTIFACT_ALLOWED_ORIGINS: origin,
  });
  const result = await validateRelease(
    {
      releaseId: '11111111-1111-4111-8111-111111111111',
      manifest,
      artifacts: [
        {
          artifactId: '22222222-2222-4222-8222-222222222222',
          fileName: 'sample.awpkg',
          url: `${origin}/sample.awpkg`,
          expectedSha256: artifactSha256,
          expectedSize: artifactBytes.length,
          signature: {
            algorithm: 'ed25519',
            keyId: 'publisher',
            value: sign(null, Buffer.from(artifactSha256, 'hex'), privateKey).toString('base64'),
          },
          sbom: {
            format: 'cyclonedx-json',
            fileName: 'sample.sbom.json',
            mediaType: 'application/vnd.cyclonedx+json',
            sha256: sbomSha256,
            url: `${origin}/sample.sbom.json`,
          },
        },
      ],
    },
    config,
  );
  assert.equal(result.success, true);
  assert.equal(result.artifactResults[0]?.success, true);
  assert.ok(result.releaseEvidence.some((item) => item.check === 'signature' && item.outcome === 'passed'));
});

async function writeZip(path: string, entries: Array<[string, Buffer]>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const archive = new yazl.ZipFile();
    for (const [name, contents] of entries) {
      archive.addBuffer(contents, name, { mtime: new Date('1980-01-01T00:00:00.000Z') });
    }
    archive.end();
    const output = archive.outputStream.pipe(createWriteStream(path));
    output.once('close', resolve);
    output.once('error', reject);
  });
}
