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

    assert.equal(
      verify(
        null,
        Buffer.from(canonicalizeManifestForSignature(first.manifest), 'utf8'),
        publicKey,
        Buffer.from(first.manifest.signature.value, 'base64'),
      ),
      true,
    );
    assert.equal(
      verify(
        null,
        Buffer.from(firstArtifact.sha256, 'hex'),
        publicKey,
        Buffer.from(firstArtifact.signature.value, 'base64'),
      ),
      true,
    );
    assert.notEqual(first.manifest.signature.value, firstArtifact.signature.value);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('multi-artifact desktop package binds and signs the complete deterministic artifact set', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aw-cli-multi-package-'));
  const windowsInput = join(directory, 'windows-x64');
  const macosInput = join(directory, 'macos-arm64');
  const manifestPath = join(directory, 'desktop.manifest.json');
  const keyPath = join(directory, 'publisher.pem');
  const firstOutput = join(directory, 'first');
  const secondOutput = join(directory, 'second');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const placeholder = {
    algorithm: 'ed25519',
    keyId: 'unconfigured-publisher-key',
    value: 'UNSIGNED_TEMPLATE_REPLACED_BY_AW_PACKAGE_000000000000000000000000',
  } as const;
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
          signature: placeholder,
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
    await writeFile(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });

    const first = await packageRelease({
      manifestPath,
      artifactInputs: [
        { name: 'windows-x64-native', inputDirectory: windowsInput },
        { name: 'macos-arm64-native', inputDirectory: macosInput },
      ],
      outputDirectory: firstOutput,
      keyId: 'publisher-test',
      privateKeyPath: keyPath,
    });
    const second = await packageRelease({
      manifestPath,
      artifactInputs: [
        { name: 'macos-arm64-native', inputDirectory: macosInput },
        { name: 'windows-x64-native', inputDirectory: windowsInput },
      ],
      outputDirectory: secondOutput,
      keyId: 'publisher-test',
      privateKeyPath: keyPath,
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
    assert.equal(
      verify(
        null,
        Buffer.from(canonicalizeManifestForSignature(first.manifest), 'utf8'),
        publicKey,
        Buffer.from(first.manifest.signature.value, 'base64'),
      ),
      true,
    );
    for (const artifact of first.artifacts) {
      const matching = second.artifacts.find((candidate) => candidate.name === artifact.name)!;
      assert.equal(artifact.sha256, matching.sha256);
      assert.deepEqual(
        await readFile(join(firstOutput, artifact.fileName)),
        await readFile(join(secondOutput, matching.fileName)),
      );
      assert.equal(
        verify(
          null,
          Buffer.from(artifact.sha256, 'hex'),
          publicKey,
          Buffer.from(artifact.signature.value, 'base64'),
        ),
        true,
      );
    }
    const readBack = await readPackageMetadata(first.metadataPath);
    assert.equal(readBack.artifacts.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('checked-in Python and Web UI examples produce complete signed package metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aw-cli-examples-'));
  const keyPath = join(directory, 'publisher.pem');
  const { privateKey } = generateKeyPairSync('ed25519');
  const examplesRoot = resolve(process.cwd(), '../../examples');
  await writeFile(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
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
        keyId: 'example-test-publisher',
        privateKeyPath: keyPath,
      });
      assert.equal(packaged.metadata.schemaVersion, 2);
      assert.equal(packaged.artifacts.length, expectedArtifacts);
      assert.equal((await readPackageMetadata(packaged.metadataPath)).artifacts.length, expectedArtifacts);
      assert.notEqual(
        packaged.manifest.signature.value,
        'UNSIGNED_TEMPLATE_REPLACED_BY_AW_PACKAGE_000000000000000000000000',
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
