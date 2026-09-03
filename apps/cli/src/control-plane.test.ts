import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ApiClient } from './api-client.js';
import { promoteRelease, publishPackagedRelease } from './control-plane.js';
import { runWithCliLocale } from './i18n.js';
import { initializeManifest, packageRelease } from './package-release.js';

test('publish preserves create, upload, finalize, submit ordering including the required SBOM upload', async () => {
  const fixture = await createPackageFixture();
  const calls: string[] = [];
  const languageHeaders: Array<{ host: string; language: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    calls.push(`${method} ${url.pathname}`);
    languageHeaders.push({ host: url.hostname, language: headers.get('accept-language') });
    if (url.pathname.endsWith('/releases') && method === 'POST') return json({ id: 'release-1' });
    if (url.pathname.endsWith('/artifacts') && method === 'POST') {
      return json({
        artifact: { id: 'artifact-1' },
        upload: {
          method: 'PUT',
          url: 'https://objects.example.test/artifact.zip',
          headers: { 'accept-language': 'must-not-leak-to-storage' },
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
        sbomUpload: {
          method: 'PUT',
          url: 'https://objects.example.test/sbom.json',
          headers: { 'accept-language': 'must-not-leak-to-storage' },
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
      });
    }
    if (url.hostname === 'objects.example.test')
      return new Response(null, { status: 200, headers: { etag: 'fixture-etag' } });
    if (url.pathname.endsWith('/finalize')) return json({ id: 'artifact-1' });
    if (url.pathname.endsWith('/submit')) {
      return json({
        release: { id: 'release-1', version: '0.1.0', status: 'validating' },
        artifacts: [{ fileName: fixture.artifactFileName, status: 'uploaded' }],
        reviews: [],
      });
    }
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  try {
    const summary = await runWithCliLocale('zh-CN', () =>
      publishPackagedRelease({
        api: new ApiClient('https://api.example.test', 'publisher-session', fetchImpl),
        applicationId: 'application-1',
        metadataPath: fixture.metadataPath,
      }),
    );
    assert.equal(summary.status, 'validating');
    assert.deepEqual(calls, [
      'POST /api/v1/applications/application-1/releases',
      'POST /api/v1/releases/release-1/artifacts',
      'PUT /artifact.zip',
      'PUT /sbom.json',
      'POST /api/v1/artifacts/artifact-1/finalize',
      'POST /api/v1/releases/release-1/submit',
    ]);
    assert.equal(
      languageHeaders
        .filter((entry) => entry.host === 'api.example.test')
        .every((entry) => entry.language === 'zh-CN'),
      true,
    );
    assert.equal(
      languageHeaders
        .filter((entry) => entry.host === 'objects.example.test')
        .every((entry) => entry.language === null),
      true,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('publish uploads and finalizes every artifact before submitting one multi-platform release', async () => {
  const fixture = await createMultiPackageFixture();
  const calls: string[] = [];
  let artifactSequence = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname.endsWith('/releases') && method === 'POST') return json({ id: 'release-1' });
    if (url.pathname.endsWith('/artifacts') && method === 'POST') {
      artifactSequence += 1;
      return json({
        artifact: { id: `artifact-${artifactSequence}` },
        upload: {
          method: 'PUT',
          url: `https://objects.example.test/artifact-${artifactSequence}.zip`,
          headers: {},
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
        sbomUpload: {
          method: 'PUT',
          url: `https://objects.example.test/sbom-${artifactSequence}.json`,
          headers: {},
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
      });
    }
    if (url.hostname === 'objects.example.test') {
      return new Response(null, { status: 200, headers: { etag: `etag-${artifactSequence}` } });
    }
    if (url.pathname.endsWith('/finalize')) return json({});
    if (url.pathname.endsWith('/submit')) {
      return json({
        release: { id: 'release-1', version: '1.0.0', status: 'validating' },
        artifacts: fixture.artifactFileNames.map((fileName) => ({ fileName, status: 'uploaded' })),
        reviews: [],
      });
    }
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  try {
    const summary = await publishPackagedRelease({
      api: new ApiClient('https://api.example.test', 'publisher-session', fetchImpl),
      applicationId: 'application-1',
      metadataPath: fixture.metadataPath,
    });
    assert.equal(summary.artifacts.length, 2);
    assert.deepEqual(calls, [
      'POST /api/v1/applications/application-1/releases',
      'POST /api/v1/releases/release-1/artifacts',
      'PUT /artifact-1.zip',
      'PUT /sbom-1.json',
      'POST /api/v1/artifacts/artifact-1/finalize',
      'POST /api/v1/releases/release-1/artifacts',
      'PUT /artifact-2.zip',
      'PUT /sbom-2.json',
      'POST /api/v1/artifacts/artifact-2/finalize',
      'POST /api/v1/releases/release-1/submit',
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test('publish refuses to finalize when server omits the SBOM upload intent', async () => {
  const fixture = await createPackageFixture();
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname.endsWith('/releases')) return json({ id: 'release-1' });
    return json({
      artifact: { id: 'artifact-1' },
      upload: {
        method: 'PUT',
        url: 'https://objects.example.test/artifact.zip',
        headers: {},
        expiresAt: '2999-01-01T00:00:00.000Z',
      },
    });
  }) as typeof fetch;
  try {
    await assert.rejects(
      publishPackagedRelease({
        api: new ApiClient('https://api.example.test', 'publisher-session', fetchImpl),
        applicationId: 'application-1',
        metadataPath: fixture.metadataPath,
      }),
      /SBOM upload intent/,
    );
    assert.equal(
      calls.some((call) => call.includes('finalize')),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('promotion always sends the optimistic concurrency field', async () => {
  let body: unknown;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as unknown;
    return json({ applicationId: 'app', releaseId: 'next', channel: 'stable' });
  }) as typeof fetch;
  await promoteRelease({
    api: new ApiClient('https://api.example.test', 'session', fetchImpl),
    applicationId: 'app',
    releaseId: 'next',
    channel: 'stable',
    expectedCurrentReleaseId: null,
  });
  assert.deepEqual(body, { releaseId: 'next', expectedCurrentReleaseId: null });
});

async function createPackageFixture(): Promise<{
  metadataPath: string;
  artifactFileName: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'aw-cli-publish-'));
  const input = join(directory, 'dist');
  const manifestPath = join(directory, 'manifest.json');
  const keyPath = join(directory, 'key.pem');
  const output = join(directory, 'package');
  const { privateKey } = generateKeyPairSync('ed25519');
  await mkdir(input);
  await writeFile(join(input, 'mf-manifest.json'), '{}');
  await writeFile(join(input, 'remoteEntry.js'), 'export {};');
  await initializeManifest({ kind: 'web', appId: 'publish-test', outputPath: manifestPath });
  await writeFile(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const packaged = await packageRelease({
    manifestPath,
    inputDirectory: input,
    outputDirectory: output,
    keyId: 'publisher',
    privateKeyPath: keyPath,
  });
  return {
    metadataPath: packaged.metadataPath,
    artifactFileName: packaged.artifacts[0]!.fileName,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function createMultiPackageFixture(): Promise<{
  metadataPath: string;
  artifactFileNames: string[];
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'aw-cli-multi-publish-'));
  const windowsInput = join(directory, 'windows');
  const macosInput = join(directory, 'macos');
  const manifestPath = join(directory, 'manifest.json');
  const keyPath = join(directory, 'key.pem');
  const output = join(directory, 'package');
  const { privateKey } = generateKeyPairSync('ed25519');
  await mkdir(join(windowsInput, 'bin'), { recursive: true });
  await mkdir(join(macosInput, 'bin'), { recursive: true });
  await writeFile(join(windowsInput, 'bin', 'app.exe'), 'windows');
  await writeFile(join(macosInput, 'bin', 'app'), 'macos');
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      kind: 'desktop',
      appId: 'publish-multi',
      version: '1.0.0',
      name: 'Publish multi',
      description: 'Multi-platform publishing fixture',
      artifacts: [
        {
          name: 'windows-x64',
          fileName: 'template-windows.zip',
          mediaType: 'application/zip',
          size: 1,
          sha256: '0'.repeat(64),
          platform: { os: 'windows', arch: 'x64' },
        },
        {
          name: 'macos-arm64',
          fileName: 'template-macos.zip',
          mediaType: 'application/zip',
          size: 1,
          sha256: '0'.repeat(64),
          platform: { os: 'macos', arch: 'arm64' },
        },
      ],
      integrity: { algorithm: 'sha256', digest: '0'.repeat(64) },
      signature: {
        algorithm: 'ed25519',
        keyId: 'unconfigured-publisher-key',
        value: 'UNSIGNED_TEMPLATE_REPLACED_BY_AW_PACKAGE_000000000000000000000000',
      },
      runtimes: [
        {
          kind: 'native',
          platform: { os: 'windows', arch: 'x64' },
          artifact: 'windows-x64',
          entry: 'bin/app.exe',
        },
        {
          kind: 'native',
          platform: { os: 'macos', arch: 'arm64' },
          artifact: 'macos-arm64',
          entry: 'bin/app',
        },
      ],
      dependencies: [],
      capabilities: [],
      runMode: 'singleton',
      minHostVersion: '0.1.0',
    }),
  );
  await writeFile(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const packaged = await packageRelease({
    manifestPath,
    artifactInputs: [
      { name: 'windows-x64', inputDirectory: windowsInput },
      { name: 'macos-arm64', inputDirectory: macosInput },
    ],
    outputDirectory: output,
    keyId: 'publisher',
    privateKeyPath: keyPath,
  });
  return {
    metadataPath: packaged.metadataPath,
    artifactFileNames: packaged.artifacts.map((artifact) => artifact.fileName),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
