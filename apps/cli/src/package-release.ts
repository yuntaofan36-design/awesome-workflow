import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { PublisherSignature, ReleaseManifest } from '@awesome-workflow/manifest-schema';
import {
  ReleaseManifestSchema,
  canonicalizeManifestForSignature,
  computeArtifactSetIntegritySha256,
} from '@awesome-workflow/manifest-schema';
import type { SbomDescriptor } from '@awesome-workflow/contracts';

import { type ArchiveEntry, buildDeterministicZip, collectArchiveEntries, sha256 } from './archive.js';
import { CliError, SecretRedactor, isRecord, requireEnvironmentSecret } from './safety.js';

const UNSIGNED_PLACEHOLDER = 'UNSIGNED_TEMPLATE_REPLACED_BY_AW_PACKAGE_000000000000000000000000';

export type PackageSbomMetadata = {
  primary: { path: string; descriptor: SbomDescriptor };
  cyclonedxPath: string;
  spdxPath: string;
};

export type PackagedArtifactMetadata = {
  name: string;
  path: string;
  fileName: string;
  contentType: 'application/zip';
  size: number;
  sha256: string;
  signature: PublisherSignature;
  sbom: PackageSbomMetadata;
};

/** Legacy metadata emitted by the original single-input package command. */
export type SingleArtifactPackageMetadata = {
  schemaVersion: 1;
  manifestPath: string;
  artifact: Omit<PackagedArtifactMetadata, 'sbom'>;
  sbom: PackageSbomMetadata;
};

/** Metadata for an immutable release containing one or more artifacts. */
export type MultiArtifactPackageMetadata = {
  schemaVersion: 2;
  manifestPath: string;
  artifacts: PackagedArtifactMetadata[];
};

export type PackageMetadata = SingleArtifactPackageMetadata | MultiArtifactPackageMetadata;

export type ArtifactInput = {
  name: string;
  inputDirectory: string;
};

export type PackageResult = {
  outputDirectory: string;
  metadataPath: string;
  manifest: ReleaseManifest;
  metadata: PackageMetadata;
  artifacts: PackagedArtifactMetadata[];
};

export async function initializeManifest(options: {
  kind: 'web' | 'desktop';
  appId: string;
  name?: string;
  outputPath: string;
}): Promise<ReleaseManifest> {
  const signature = {
    algorithm: 'ed25519' as const,
    keyId: 'unconfigured-publisher-key',
    value: UNSIGNED_PLACEHOLDER,
  };
  let manifest: unknown;
  if (options.kind === 'web') {
    manifest = {
      schemaVersion: 1,
      kind: 'web',
      appId: options.appId,
      version: '0.1.0',
      artifacts: [],
      integrity: { algorithm: 'sha256', digest: await computeArtifactSetIntegritySha256([]) },
      signature,
      runtime: 'federation',
      routeBase: `/${options.appId}`,
      hostApiVersion: '1',
      capabilities: ['context.read', 'navigation'],
      remoteName: remoteName(options.appId),
      exposedModule: './App',
      manifestUrl: 'http://localhost:5173/mf-manifest.json',
      integritySha256: '0'.repeat(64),
    };
  } else {
    const artifact = {
      name: 'runtime-windows-x64',
      fileName: `${options.appId}-0.1.0-windows-x64.zip`,
      mediaType: 'application/zip',
      size: 1,
      sha256: '0'.repeat(64),
      platform: { os: 'windows' as const, arch: 'x64' as const },
    };
    manifest = {
      schemaVersion: 1,
      kind: 'desktop',
      appId: options.appId,
      version: '0.1.0',
      name: options.name ?? options.appId,
      description: 'Desktop micro-application',
      artifacts: [artifact],
      integrity: { algorithm: 'sha256', digest: await computeArtifactSetIntegritySha256([artifact]) },
      signature,
      runtimes: [
        {
          kind: 'web-ui',
          platform: artifact.platform,
          artifact: artifact.name,
          entry: 'index.html',
          allowedOrigins: [],
        },
      ],
      dependencies: [],
      capabilities: [],
      runMode: 'singleton',
      minHostVersion: '0.1.0',
    };
  }
  const parsed = ReleaseManifestSchema.parse(manifest);
  await mkdir(resolve(options.outputPath, '..'), { recursive: true });
  try {
    await writeFile(options.outputPath, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new CliError(`Refusing to overwrite existing manifest: ${options.outputPath}`);
    }
    throw error;
  }
  return parsed;
}

export async function readArtifactInputMap(path: string): Promise<ArtifactInput[]> {
  const absolutePath = resolve(path);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(absolutePath, 'utf8')) as unknown;
  } catch {
    throw new CliError(`Artifact map is missing or is not valid JSON: ${path}`);
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.artifacts)) {
    throw new CliError('Artifact map must contain schemaVersion 1 and an artifacts array.');
  }
  if (value.artifacts.length === 0) throw new CliError('Artifact map must contain at least one artifact.');
  return value.artifacts.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate.name) ||
      typeof candidate.input !== 'string' ||
      !candidate.input ||
      candidate.input.includes('\0')
    ) {
      throw new CliError(`Artifact map entry ${index + 1} must contain a valid name and input path.`);
    }
    return { name: candidate.name, inputDirectory: resolve(dirname(absolutePath), candidate.input) };
  });
}

export async function packageRelease(options: {
  manifestPath: string;
  inputDirectory?: string;
  artifactInputs?: readonly ArtifactInput[];
  outputDirectory: string;
  keyId: string;
  privateKeyPath?: string;
  privateKeyEnvironmentName?: string;
  artifactName?: string;
  environment?: NodeJS.ProcessEnv;
  redactor?: SecretRedactor;
}): Promise<PackageResult> {
  if (!options.keyId || options.keyId.length > 160)
    throw new CliError('--key-id must contain 1 to 160 characters.');
  const outputDirectory = resolve(options.outputDirectory);
  const manifest = await readManifest(options.manifestPath);
  const legacyMode = options.artifactInputs === undefined;
  const inputs = selectArtifactInputs(manifest, options);
  const builtArtifacts = await Promise.all(
    inputs.map(async (input) => {
      const inputDirectory = resolve(input.inputDirectory);
      assertOutputOutsideInput(inputDirectory, outputDirectory);
      const sourceEntries = await collectArchiveEntries(inputDirectory);
      validateRuntimeFiles(manifest, input.name, sourceEntries);
      const sbomDocuments = createSbomDocuments(manifest, sourceEntries, legacyMode ? undefined : input.name);
      const archive = buildDeterministicZip([
        ...sourceEntries,
        { name: 'META-INF/sbom.cdx.json', bytes: sbomDocuments.cyclonedx },
        { name: 'META-INF/sbom.spdx.json', bytes: sbomDocuments.spdx },
      ]);
      const stem = legacyMode
        ? `${manifest.appId}-${manifest.version}`
        : `${manifest.appId}-${manifest.version}-${input.name}`;
      return {
        name: input.name,
        sourceEntries,
        sbomDocuments,
        archive,
        sha256: sha256(archive),
        artifactFileName: `${stem}.zip`,
        cyclonedxFileName: `${stem}.cdx.json`,
        spdxFileName: `${stem}.spdx.json`,
      };
    }),
  );
  builtArtifacts.sort((left, right) => left.name.localeCompare(right.name));

  let updatedArtifacts = manifest.artifacts;
  for (const artifact of builtArtifacts) {
    updatedArtifacts = updateArtifact(
      { ...manifest, artifacts: updatedArtifacts } as ReleaseManifest,
      artifact.name,
      {
        fileName: artifact.artifactFileName,
        mediaType: 'application/zip',
        size: artifact.archive.length,
        sha256: artifact.sha256,
      },
    );
  }

  const unsignedCandidate = updateRuntimeIntegrity(
    {
      ...manifest,
      artifacts: updatedArtifacts,
      integrity: {
        algorithm: 'sha256' as const,
        digest: await computeArtifactSetIntegritySha256(updatedArtifacts),
      },
      signature: { algorithm: 'ed25519' as const, keyId: options.keyId, value: UNSIGNED_PLACEHOLDER },
    } as ReleaseManifest,
    legacyMode ? builtArtifacts[0]!.sourceEntries : [],
  );
  const parsedUnsigned = ReleaseManifestSchema.parse(unsignedCandidate);
  const privateKey = await loadPrivateKey(options);
  const manifestSignature = signatureEnvelope(
    options.keyId,
    sign(null, Buffer.from(canonicalizeManifestForSignature(parsedUnsigned), 'utf8'), privateKey),
  );
  const signedManifest = ReleaseManifestSchema.parse({ ...parsedUnsigned, signature: manifestSignature });
  const packagedArtifacts: PackagedArtifactMetadata[] = builtArtifacts.map((artifact) => {
    const primaryDescriptor: SbomDescriptor = {
      format: 'cyclonedx-json',
      fileName: artifact.cyclonedxFileName,
      mediaType: 'application/vnd.cyclonedx+json',
      sha256: sha256(artifact.sbomDocuments.cyclonedx),
    };
    return {
      name: artifact.name,
      path: artifact.artifactFileName,
      fileName: artifact.artifactFileName,
      contentType: 'application/zip',
      size: artifact.archive.length,
      sha256: artifact.sha256,
      signature: signatureEnvelope(
        options.keyId,
        sign(null, Buffer.from(artifact.sha256, 'hex'), privateKey),
      ),
      sbom: {
        primary: { path: artifact.cyclonedxFileName, descriptor: primaryDescriptor },
        cyclonedxPath: artifact.cyclonedxFileName,
        spdxPath: artifact.spdxFileName,
      },
    };
  });
  const manifestPath = 'release.manifest.json';
  const metadata: PackageMetadata = legacyMode
    ? {
        schemaVersion: 1,
        manifestPath,
        artifact: omitSbom(packagedArtifacts[0]!),
        sbom: packagedArtifacts[0]!.sbom,
      }
    : { schemaVersion: 2, manifestPath, artifacts: packagedArtifacts };

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(outputDirectory, manifestPath), `${JSON.stringify(signedManifest, null, 2)}\n`, 'utf8'),
    writeFile(join(outputDirectory, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8'),
    ...builtArtifacts.flatMap((artifact) => [
      writeFile(join(outputDirectory, artifact.artifactFileName), artifact.archive),
      writeFile(join(outputDirectory, artifact.cyclonedxFileName), artifact.sbomDocuments.cyclonedx),
      writeFile(join(outputDirectory, artifact.spdxFileName), artifact.sbomDocuments.spdx),
    ]),
  ]);
  return {
    outputDirectory,
    metadataPath: join(outputDirectory, 'package.json'),
    manifest: signedManifest,
    metadata,
    artifacts: packagedArtifacts,
  };
}

export async function readPackageMetadata(metadataPath: string): Promise<{
  metadata: PackageMetadata;
  manifest: ReleaseManifest;
  artifacts: Array<{
    metadata: PackagedArtifactMetadata;
    artifactBytes: Buffer;
    sbomBytes: Buffer;
  }>;
}> {
  const absoluteMetadataPath = resolve(metadataPath);
  const directory = resolve(absoluteMetadataPath, '..');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(absoluteMetadataPath, 'utf8')) as unknown;
  } catch {
    throw new CliError('Package metadata is missing or invalid. Run `aw package` first.');
  }
  const metadata = parsePackageMetadata(value);
  const manifest = await readManifest(resolvePackageChild(directory, metadata.manifestPath));
  const artifactMetadata =
    metadata.schemaVersion === 1 ? [{ ...metadata.artifact, sbom: metadata.sbom }] : metadata.artifacts;
  if (artifactMetadata.length !== manifest.artifacts.length) {
    throw new CliError('Package metadata does not contain the complete signed manifest artifact set.');
  }
  const artifacts = await Promise.all(
    artifactMetadata.map(async (artifact) => {
      const artifactBytes = await readFile(resolvePackageChild(directory, artifact.path));
      const sbomBytes = await readFile(resolvePackageChild(directory, artifact.sbom.primary.path));
      if (artifactBytes.length !== artifact.size || sha256(artifactBytes) !== artifact.sha256) {
        throw new CliError(
          `Packaged artifact ${artifact.name} bytes no longer match package metadata. Re-run \`aw package\`.`,
        );
      }
      if (sha256(sbomBytes) !== artifact.sbom.primary.descriptor.sha256) {
        throw new CliError(
          `Packaged SBOM for ${artifact.name} no longer matches package metadata. Re-run \`aw package\`.`,
        );
      }
      const declaration = manifest.artifacts.find((candidate) => candidate.name === artifact.name);
      if (
        !declaration ||
        declaration.fileName !== artifact.fileName ||
        declaration.mediaType !== artifact.contentType ||
        declaration.size !== artifact.size ||
        declaration.sha256 !== artifact.sha256
      ) {
        throw new CliError('Package metadata does not match the signed manifest artifact declaration.');
      }
      return { metadata: artifact, artifactBytes, sbomBytes };
    }),
  );
  return { metadata, manifest, artifacts };
}

function createSbomDocuments(
  manifest: ReleaseManifest,
  entries: readonly ArchiveEntry[],
  artifactName?: string,
): { cyclonedx: Buffer; spdx: Buffer } {
  const files = [...entries]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((entry) => ({ name: entry.name, sha256: sha256(entry.bytes), size: entry.bytes.length }));
  const sourceSetSha256 = sha256(Buffer.from(JSON.stringify(files), 'utf8'));
  const cyclonedx = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        name: artifactName ? `${manifest.appId}:${artifactName}` : manifest.appId,
        version: manifest.version,
      },
    },
    components: files.map((file) => ({
      type: 'file',
      name: file.name,
      hashes: [{ alg: 'SHA-256', content: file.sha256 }],
      properties: [{ name: 'awesome-workflow:file-size', value: String(file.size) }],
    })),
  };
  const spdx = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${manifest.appId}-${manifest.version}${artifactName ? `-${artifactName}` : ''}`,
    documentNamespace: `https://awesome-workflow.invalid/spdx/${encodeURIComponent(manifest.appId)}/${encodeURIComponent(manifest.version)}/${artifactName ? `${encodeURIComponent(artifactName)}/` : ''}${sourceSetSha256}`,
    creationInfo: { created: '1980-01-01T00:00:00Z', creators: ['Tool: aw-0.1.0'] },
    files: files.map((file, index) => ({
      fileName: `./${file.name}`,
      SPDXID: `SPDXRef-File-${index + 1}`,
      checksums: [{ algorithm: 'SHA256', checksumValue: file.sha256 }],
      licenseConcluded: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
    })),
  };
  return {
    cyclonedx: Buffer.from(`${JSON.stringify(cyclonedx, null, 2)}\n`, 'utf8'),
    spdx: Buffer.from(`${JSON.stringify(spdx, null, 2)}\n`, 'utf8'),
  };
}

async function loadPrivateKey(options: {
  privateKeyPath?: string;
  privateKeyEnvironmentName?: string;
  environment?: NodeJS.ProcessEnv;
  redactor?: SecretRedactor;
}): Promise<KeyObject> {
  if (Boolean(options.privateKeyPath) === Boolean(options.privateKeyEnvironmentName)) {
    throw new CliError('Provide exactly one of --private-key PATH or --private-key-env NAME.');
  }
  let serialized: string | Buffer;
  if (options.privateKeyPath) {
    const keyPath = resolve(options.privateKeyPath);
    const metadata = await stat(keyPath);
    if (!metadata.isFile()) throw new CliError('Publisher private key path is not a regular file.');
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw new CliError(
        'Publisher private key file must not be readable by group or other users (expected mode 0600).',
      );
    }
    serialized = await readFile(keyPath);
  } else {
    serialized = requireEnvironmentSecret(
      options.privateKeyEnvironmentName!,
      options.environment ?? process.env,
      options.redactor,
    );
  }
  let key: KeyObject;
  try {
    const text = Buffer.isBuffer(serialized) ? serialized.toString('utf8') : serialized;
    key = text.includes('-----BEGIN')
      ? createPrivateKey(text)
      : createPrivateKey({ key: Buffer.from(text.trim(), 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    throw new CliError('Publisher private key must be an Ed25519 PKCS#8 PEM or base64-encoded DER value.');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new CliError('Publisher private key must use Ed25519.');
  return key;
}

function signatureEnvelope(keyId: string, bytes: Buffer): PublisherSignature {
  return { algorithm: 'ed25519', keyId, value: bytes.toString('base64') };
}

async function readManifest(path: string): Promise<ReleaseManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  } catch {
    throw new CliError(`Manifest is missing or is not valid JSON: ${path}`);
  }
  const parsed = ReleaseManifestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CliError(
      `Manifest validation failed${issue ? ` at ${issue.path.join('.') || '<root>'}: ${issue.message}` : '.'}`,
    );
  }
  return parsed.data;
}

function updateArtifact(
  manifest: ReleaseManifest,
  name: string,
  update: { fileName: string; mediaType: string; size: number; sha256: string },
): ReleaseManifest['artifacts'] {
  const existing = manifest.artifacts.find((artifact) => artifact.name === name);
  const artifact = existing ? { ...existing, ...update } : { name, ...update };
  return [...manifest.artifacts.filter((candidate) => candidate.name !== name), artifact].sort(
    (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  );
}

function selectArtifactInputs(
  manifest: ReleaseManifest,
  options: { inputDirectory?: string; artifactInputs?: readonly ArtifactInput[]; artifactName?: string },
): ArtifactInput[] {
  if (options.artifactInputs !== undefined) {
    if (options.inputDirectory || options.artifactName) {
      throw new CliError('Artifact-map packaging cannot be combined with --input or --artifact-name.');
    }
    if (manifest.kind !== 'desktop') {
      throw new CliError('Artifact-map packaging is supported only for desktop release manifests.');
    }
    if (options.artifactInputs.length === 0) {
      throw new CliError('Artifact map must contain at least one artifact.');
    }
    const names = new Set<string>();
    for (const input of options.artifactInputs) {
      if (names.has(input.name)) throw new CliError(`Artifact map contains duplicate name: ${input.name}`);
      names.add(input.name);
      if (!manifest.artifacts.some((artifact) => artifact.name === input.name)) {
        throw new CliError(`Artifact map name is not declared by the manifest: ${input.name}`);
      }
    }
    const missing = manifest.artifacts.filter((artifact) => !names.has(artifact.name));
    if (missing.length > 0) {
      throw new CliError(
        `Artifact map must cover the complete manifest artifact set; missing: ${missing
          .map((artifact) => artifact.name)
          .join(', ')}`,
      );
    }
    return [...options.artifactInputs].sort((left, right) => left.name.localeCompare(right.name));
  }
  if (!options.inputDirectory) throw new CliError('Package input directory is required.');
  return [
    { name: selectArtifactName(manifest, options.artifactName), inputDirectory: options.inputDirectory },
  ];
}

function selectArtifactName(manifest: ReleaseManifest, requested: string | undefined): string {
  if (manifest.artifacts.length > 1) {
    throw new CliError(
      'Manifest declares multiple artifacts; use --artifact-map so one package contains the complete release artifact set.',
    );
  }
  if (requested) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requested)) throw new CliError('--artifact-name is invalid.');
    const existing = manifest.artifacts[0];
    if (existing && existing.name !== requested) {
      throw new CliError('--artifact-name must match the manifest artifact when one is already declared.');
    }
    return requested;
  }
  if (manifest.artifacts.length === 1) return manifest.artifacts[0]!.name;
  if (manifest.artifacts.length === 0 && manifest.kind === 'web') return 'web-bundle';
  throw new CliError('Desktop manifest must declare at least one artifact.');
}

function updateRuntimeIntegrity(
  manifest: ReleaseManifest,
  entries: readonly ArchiveEntry[],
): ReleaseManifest {
  if (manifest.kind !== 'web' || manifest.runtime !== 'federation') return manifest;
  const fileName = basename(new URL(manifest.manifestUrl).pathname);
  const matches = entries.filter((entry) => entry.name === fileName || entry.name.endsWith(`/${fileName}`));
  if (matches.length !== 1) {
    throw new CliError(
      `Federation package must contain exactly one ${fileName} so integritySha256 can be bound.`,
    );
  }
  return { ...manifest, integritySha256: sha256(matches[0]!.bytes) };
}

function validateRuntimeFiles(
  manifest: ReleaseManifest,
  artifactName: string,
  entries: readonly ArchiveEntry[],
): void {
  if (manifest.kind !== 'desktop') return;
  const names = new Set(entries.map((entry) => entry.name));
  for (const runtime of manifest.runtimes.filter((candidate) => candidate.artifact === artifactName)) {
    if (!names.has(runtime.entry))
      throw new CliError(
        `Desktop runtime entry for artifact ${artifactName} is missing from package input: ${runtime.entry}`,
      );
  }
}

function omitSbom(artifact: PackagedArtifactMetadata): Omit<PackagedArtifactMetadata, 'sbom'> {
  const { sbom: _sbom, ...metadata } = artifact;
  return metadata;
}

function parsePackageMetadata(value: unknown): PackageMetadata {
  if (!isRecord(value) || typeof value.manifestPath !== 'string') {
    throw new CliError('Package metadata has an unsupported shape.');
  }
  if (value.schemaVersion === 1 && isRecord(value.artifact)) {
    const artifact = parsePackagedArtifact({ ...value.artifact, sbom: value.sbom });
    return {
      schemaVersion: 1,
      manifestPath: value.manifestPath,
      artifact: omitSbom(artifact),
      sbom: artifact.sbom,
    };
  }
  if (value.schemaVersion === 2 && Array.isArray(value.artifacts) && value.artifacts.length > 0) {
    const artifacts = value.artifacts.map(parsePackagedArtifact);
    const names = new Set<string>();
    const paths = new Set<string>();
    for (const artifact of artifacts) {
      if (names.has(artifact.name)) throw new CliError('Package metadata contains duplicate artifact names.');
      names.add(artifact.name);
      if (artifact.sbom.primary.path !== artifact.sbom.cyclonedxPath) {
        throw new CliError('Primary SBOM path must match the CycloneDX package path.');
      }
      for (const path of [artifact.path, artifact.sbom.cyclonedxPath, artifact.sbom.spdxPath]) {
        if (paths.has(path)) throw new CliError('Package metadata contains duplicate file paths.');
        paths.add(path);
      }
    }
    return { schemaVersion: 2, manifestPath: value.manifestPath, artifacts };
  }
  throw new CliError('Package metadata has an unsupported shape.');
}

function parsePackagedArtifact(value: unknown): PackagedArtifactMetadata {
  if (!isRecord(value)) throw new CliError('Package artifact metadata has an unsupported shape.');
  const sbom = parseSbomMetadata(value.sbom);
  if (
    typeof value.name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.name) ||
    typeof value.path !== 'string' ||
    typeof value.fileName !== 'string' ||
    value.contentType !== 'application/zip' ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !isPublisherSignature(value.signature)
  ) {
    throw new CliError('Package artifact metadata has an unsupported shape.');
  }
  return {
    name: value.name,
    path: value.path,
    fileName: value.fileName,
    contentType: 'application/zip',
    size: value.size,
    sha256: value.sha256,
    signature: value.signature,
    sbom,
  };
}

function parseSbomMetadata(value: unknown): PackageSbomMetadata {
  if (!isRecord(value) || !isRecord(value.primary)) {
    throw new CliError('Package metadata is missing its primary SBOM.');
  }
  const primary = value.primary;
  if (!isRecord(primary.descriptor)) {
    throw new CliError('Package metadata is missing its primary SBOM descriptor.');
  }
  const descriptor = primary.descriptor;
  if (
    typeof primary.path !== 'string' ||
    descriptor.format !== 'cyclonedx-json' ||
    typeof descriptor.fileName !== 'string' ||
    descriptor.mediaType !== 'application/vnd.cyclonedx+json' ||
    typeof descriptor.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
    typeof value.cyclonedxPath !== 'string' ||
    typeof value.spdxPath !== 'string'
  ) {
    throw new CliError('Package SBOM metadata has an unsupported shape.');
  }
  return {
    primary: {
      path: primary.path,
      descriptor: {
        format: 'cyclonedx-json',
        fileName: descriptor.fileName,
        mediaType: 'application/vnd.cyclonedx+json',
        sha256: descriptor.sha256,
      },
    },
    cyclonedxPath: value.cyclonedxPath,
    spdxPath: value.spdxPath,
  };
}

function isPublisherSignature(value: unknown): value is PublisherSignature {
  return (
    isRecord(value) &&
    value.algorithm === 'ed25519' &&
    typeof value.keyId === 'string' &&
    typeof value.value === 'string'
  );
}

function resolvePackageChild(directory: string, child: string): string {
  if (!child || isAbsolute(child) || child.includes('\\'))
    throw new CliError('Package metadata contains an unsafe file path.');
  const components = child.split('/');
  if (components.some((component) => component === '' || component === '.' || component === '..')) {
    throw new CliError('Package metadata contains an unsafe file path.');
  }
  const absolute = resolve(directory, ...components);
  const rel = relative(directory, absolute);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new CliError('Package metadata file path escapes its directory.');
  return absolute;
}

function assertOutputOutsideInput(inputDirectory: string, outputDirectory: string): void {
  const rel = relative(inputDirectory, outputDirectory);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new CliError('Package output directory must be outside the package input directory.');
  }
}

function remoteName(appId: string): string {
  return `aw_${appId.replace(/-([a-z0-9])/g, (_match, character: string) => character.toUpperCase())}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
