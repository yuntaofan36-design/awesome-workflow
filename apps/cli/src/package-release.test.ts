import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  canonicalizeManifestForSignature,
  computeArtifactSetIntegritySha256,
} from '@awesome-workflow/manifest-schema';

import {
  initializeManifest,
  packageRelease,
  readArtifactInputMap,
  readPackageMetadata,
} from './package-release.js';

test('package output is deterministic and uses separate valid manifest and artifact signatures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aw-cli-package-'));
  const input = join(directory, 'dist');
  const manifestPath = join(directory, 'awesome-workflow.manifest.json');
  const keyPath = join(directory, 'publisher.pem');
  const firstOutput = join(directory, 'first');
  const secondOutput = join(directory, 'second');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  try {
    await mkdir(input);
    await writeFile(join(input, 'mf-manifest.json'), '{"name":"testApp"}\n');
    await writeFile(join(input, 'remoteEntry.js'), 'export default "ok";\n');
    await initializeManifest({ kind: 'web', appId: 'test-app', outputPath: manifestPath });
    await writeFile(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });

    const first = await packageRelease({
      manifestPath,
      inputDirectory: input,
      outputDirectory: firstOutput,
      keyId: 'publisher-test',
      privateKeyPath: keyPath,
    });
    const second = await packageRelease({
      manifestPath,
      inputDirectory: input,
      outputDirectory: secondOutput,
      keyId: 'publisher-test',
      privateKeyPath: keyPath,
    });
    assert.equal(first.metadata.schemaVersion, 1);
    const firstArtifact = first.artifacts[0]!;
    const secondArtifact = second.artifacts[0]!;
    const firstArchive = await readFile(join(firstOutput, firstArtifact.fileName));
    const secondArchive = await readFile(join(secondOutput, secondArtifact.fileName));
    assert.deepEqual(firstArchive, secondArchive);
    assert.equal(firstArtifact.sha256, secondArtifact.sha256);
    assert.equal(first.manifest.kind, 'web');
    if (first.manifest.kind === 'web' && first.manifest.runtime === 'federation') {
      assert.match(new URL(first.manifest.manifestUrl).pathname, new RegExp(first.manifest.integritySha256));
      assert.equal(first.manifest.manifestUrl.includes('__AW_FEDERATION_SHA256__'), false);
      assert.deepEqual(first.manifest.resourceOrigins, ['http://localhost:5173']);
    }

    assert.equal(
      verify(
        null,
        Buffer.from(canonicalizeManifestForSignature(first.manifest), 'utf8'),
        publicKey,
        Buffer.from(first.manifest.signature.value, 'base64'),
      ),
      true,
    );
    const artifactSignature = firstArtifact.signature;
    assert.ok(artifactSignature);
    assert.equal(
      verify(
        null,
        Buffer.from(firstArtifact.sha256, 'hex'),
        publicKey,
        Buffer.from(artifactSignature.value, 'base64'),
      ),
      true,
    );
    assert.notEqual(first.manifest.signature.value, artifactSignature.value);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('web packaging still requires a publisher key id and private key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aw-cli-web-signature-'));
  const input = join(directory, 'dist');
  const manifestPath = join(directory, 'web.manifest.json');
  try {
    await mkdir(input);
    await writeFile(join(input, 'mf-manifest.json'), '{}');
    await writeFile(join(input, 'remoteEntry.js'), 'export {};');
    await initializeManifest({ kind: 'web', appId: 'signed-web', outputPath: manifestPath });
    await assert.rejects(
      packageRelease({
        manifestPath,
        inputDirectory: input,
        outputDirectory: join(directory, 'package'),
      }),
      /--key-id/,
    );
    await assert.rejects(
      packageRelease({
        manifestPath,
        inputDirectory: input,
        outputDirectory: join(directory, 'package'),
        keyId: 'publisher-test',
      }),
      /exactly one of --private-key/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('multi-artifact desktop package binds the complete deterministic artifact set without signatures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aw-cli-multi-package-'));
  const windowsInput = join(directory, 'windows-x64');
  const macosInput = join(directory, 'macos-arm64');
  const manifestPath = join(directory, 'desktop.manifest.json');
  const firstOutput = join(directory, 'first');
  const secondOutput = join(directory, 'second');
  const artifacts = [
    {
      name: 'windows-x64-native',
      fileName: 'template-windows.zip',
      mediaType: 'application/zip',
      size: 1,
      sha256: '0'.repeat(64),
      platform: { os: 'windows', arch: 'x64' },
    },
    {
      name: 'macos-arm64-native',
      fileName: 'template-macos.zip',
      mediaType: 'application/zip',
      size: 1,
      sha256: '0'.repeat(64),
      platform: { os: 'macos', arch: 'arm64' },
    },
  ] as const;
  try {
    await mkdir(join(windowsInput, 'bin'), { recursive: true });
    await mkdir(join(macosInput, 'bin'), { recursive: true });
    await writeFile(join(windowsInput, 'bin', 'example.exe'), 'real-windows-build-output');
    await writeFile(join(macosInput, 'bin', 'example'), 'real-macos-build-output');
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: 'desktop',
          appId: 'multi-native',
          version: '1.0.0',
          name: 'Multi native',
          description: 'Two target desktop package fixture',
          artifacts,
          integrity: { algorithm: 'sha256', digest: '0'.repeat(64) },
          runtimes: [
            {
              kind: 'native',
              platform: { os: 'windows', arch: 'x64' },
              artifact: 'windows-x64-native',
              entry: 'bin/example.exe',
            },
            {
              kind: 'native',
              platform: { os: 'macos', arch: 'arm64' },
              artifact: 'macos-arm64-native',
              entry: 'bin/example',
            },
          ],
          dependencies: [],
          capabilities: [],
          runMode: 'singleton',
          minHostVersion: '0.1.0',
        },
        null,
        2,
      )}\n`,
    );
    const first = await packageRelease({
      manifestPath,
      artifactInputs: [
        { name: 'windows-x64-native', inputDirectory: windowsInput },
        { name: 'macos-arm64-native', inputDirectory: macosInput },
      ],
      outputDirectory: firstOutput,
    });
    const second = await packageRelease({
      manifestPath,
      artifactInputs: [
        { name: 'macos-arm64-native', inputDirectory: macosInput },
        { name: 'windows-x64-native', inputDirectory: windowsInput },
      ],
      outputDirectory: secondOutput,
    });

    assert.equal(first.metadata.schemaVersion, 2);
    assert.deepEqual(
      first.artifacts.map((artifact) => artifact.name),
      ['macos-arm64-native', 'windows-x64-native'],
    );
    assert.equal(
      first.manifest.integrity.digest,
      await computeArtifactSetIntegritySha256(first.manifest.artifacts),
    );
    assert.equal(first.manifest.kind, 'desktop');
    assert.equal(Object.hasOwn(first.manifest, 'signature'), false);
    for (const artifact of first.artifacts) {
      const matching = second.artifacts.find((candidate) => candidate.name === artifact.name)!;
      assert.equal(artifact.sha256, matching.sha256);
      assert.deepEqual(
        await readFile(join(firstOutput, artifact.fileName)),
        await readFile(join(secondOutput, matching.fileName)),
      );
      assert.equal(Object.hasOwn(artifact, 'signature'), false);
    }
    const readBack = await readPackageMetadata(first.metadataPath);
    assert.equal(readBack.artifacts.length, 2);
    assert.equal(
      readBack.artifacts.every((artifact) => !artifact.metadata.signature),
      true,
    );
    assert.equal((await readFile(first.metadataPath, 'utf8')).includes('"signature"'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('checked-in Python and Web UI desktop examples produce complete unsigned package metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aw-cli-examples-'));
  const examplesRoot = resolve(process.cwd(), '../../examples');
  try {
    for (const [name, expectedArtifacts] of [
      ['desktop-applet', 2],
      ['desktop-web-ui-applet', 1],
    ] as const) {
      const exampleRoot = join(examplesRoot, name);
      const packaged = await packageRelease({
        manifestPath: join(exampleRoot, 'applet.json'),
        artifactInputs: await readArtifactInputMap(join(exampleRoot, 'aw.package.json')),
        outputDirectory: join(directory, name),
      });
      assert.equal(packaged.metadata.schemaVersion, 2);
      assert.equal(packaged.artifacts.length, expectedArtifacts);
      assert.equal((await readPackageMetadata(packaged.metadataPath)).artifacts.length, expectedArtifacts);
      assert.equal(packaged.manifest.kind, 'desktop');
      assert.equal(Object.hasOwn(packaged.manifest, 'signature'), false);
      assert.equal(
        packaged.artifacts.every((artifact) => !artifact.signature),
        true,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
