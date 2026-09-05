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
import { cliText } from './i18n.js';
import { CliError, SecretRedactor, isRecord, requireEnvironmentSecret } from './safety.js';

const UNSIGNED_PLACEHOLDER = 'UNSIGNED_TEMPLATE_REPLACED_BY_AW_PACKAGE_000000000000000000000000';
const FEDERATION_DIGEST_PLACEHOLDER = '__AW_FEDERATION_SHA256__';

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
  signature?: PublisherSignature;
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
  let manifest: unknown;
  if (options.kind === 'web') {
    const developmentOrigin = 'http://localhost:5173';
    manifest = {
      schemaVersion: 1,
      kind: 'web',
      appId: options.appId,
      version: '0.1.0',
      artifacts: [],
      integrity: { algorithm: 'sha256', digest: await computeArtifactSetIntegritySha256([]) },
      signature: {
        algorithm: 'ed25519' as const,
        keyId: 'unconfigured-publisher-key',
        value: UNSIGNED_PLACEHOLDER,
      },
      runtime: 'federation',
      routeBase: `/${options.appId}`,
      hostApiVersion: '1',
      capabilities: ['context.read', 'navigation'],
      remoteName: remoteName(options.appId),
      exposedModule: './App',
      manifestUrl: `${developmentOrigin}/releases/${FEDERATION_DIGEST_PLACEHOLDER}/mf-manifest.json`,
      integritySha256: '0'.repeat(64),
      resourceOrigins: [developmentOrigin],
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'", developmentOrigin],
        styleSrc: ["'self'", developmentOrigin],
        imgSrc: ["'self'", 'data:', developmentOrigin],
        connectSrc: ["'self'", developmentOrigin],
        frameSrc: [],
      },
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
      description: cliText('manifest.desktopDescription'),
      artifacts: [artifact],
      integrity: { algorithm: 'sha256', digest: await computeArtifactSetIntegritySha256([artifact]) },
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
      throw new CliError(cliText('package.manifestExists', { path: options.outputPath }));
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
    throw new CliError(cliText('package.artifactMapUnreadable', { path }));
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.artifacts)) {
    throw new CliError(cliText('package.artifactMapShape'));
  }
  if (value.artifacts.length === 0) throw new CliError(cliText('package.artifactMapEmpty'));
  return value.artifacts.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate.name) ||
      typeof candidate.input !== 'string' ||
      !candidate.input ||
      candidate.input.includes('\0')
    ) {
      throw new CliError(cliText('package.artifactMapEntry', { index: index + 1 }));
    }
    return { name: candidate.name, inputDirectory: resolve(dirname(absolutePath), candidate.input) };
  });
}

export async function packageRelease(options: {
  manifestPath: string;
  inputDirectory?: string;
  artifactInputs?: readonly ArtifactInput[];
  outputDirectory: string;
  keyId?: string;
  privateKeyPath?: string;
  privateKeyEnvironmentName?: string;
  artifactName?: string;
  environment?: NodeJS.ProcessEnv;
  redactor?: SecretRedactor;
}): Promise<PackageResult> {
  const outputDirectory = resolve(options.outputDirectory);
  const manifest = await readManifest(options.manifestPath);
  const signingKeyId = manifest.kind === 'web' ? requireWebSigningKeyId(options.keyId) : undefined;
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
  builtArtifacts.sort((left, right) => compareCodePoints(left.name, right.name));

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

  const packageManifestCandidate = updateRuntimeIntegrity(
    {
      ...manifest,
      artifacts: updatedArtifacts,
      integrity: {
        algorithm: 'sha256' as const,
        digest: await computeArtifactSetIntegritySha256(updatedArtifacts),
      },
    } as ReleaseManifest,
    legacyMode ? builtArtifacts[0]!.sourceEntries : [],
  );
  let packagedManifest: ReleaseManifest;
  let privateKey: KeyObject | undefined;
  if (packageManifestCandidate.kind === 'web') {
    const parsedUnsigned = ReleaseManifestSchema.parse({
      ...packageManifestCandidate,
      signature: { algorithm: 'ed25519', keyId: signingKeyId, value: UNSIGNED_PLACEHOLDER },
    });
    privateKey = await loadPrivateKey(options);
    const manifestSignature = signatureEnvelope(
      signingKeyId!,
      sign(null, Buffer.from(canonicalizeManifestForSignature(parsedUnsigned), 'utf8'), privateKey),
    );
    packagedManifest = ReleaseManifestSchema.parse({ ...parsedUnsigned, signature: manifestSignature });
  } else {
    const { signature: _legacySignature, ...unsignedDesktopManifest } =
      packageManifestCandidate as ReleaseManifest & { signature?: PublisherSignature };
    packagedManifest = ReleaseManifestSchema.parse(unsignedDesktopManifest);
  }
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
      ...(privateKey && signingKeyId
        ? {
            signature: signatureEnvelope(
              signingKeyId,
              sign(null, Buffer.from(artifact.sha256, 'hex'), privateKey),
            ),
          }
        : {}),
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
    writeFile(join(outputDirectory, manifestPath), `${JSON.stringify(packagedManifest, null, 2)}\n`, 'utf8'),
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
    manifest: packagedManifest,
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
    throw new CliError(cliText('package.metadataUnreadable'));
  }
  const metadata = parsePackageMetadata(value);
  const manifest = await readManifest(resolvePackageChild(directory, metadata.manifestPath));
  const artifactMetadata =
    metadata.schemaVersion === 1 ? [{ ...metadata.artifact, sbom: metadata.sbom }] : metadata.artifacts;
  if (manifest.kind === 'web' && artifactMetadata.some((artifact) => !artifact.signature)) {
    throw new CliError(cliText('package.webSignatureRequired'));
  }
  if (artifactMetadata.length !== manifest.artifacts.length) {
    throw new CliError(cliText('package.metadataArtifactSet'));
  }
  const artifacts = await Promise.all(
    artifactMetadata.map(async (artifact) => {
      const artifactBytes = await readFile(resolvePackageChild(directory, artifact.path));
      const sbomBytes = await readFile(resolvePackageChild(directory, artifact.sbom.primary.path));
      if (artifactBytes.length !== artifact.size || sha256(artifactBytes) !== artifact.sha256) {
        throw new CliError(cliText('package.artifactBytesChanged', { name: artifact.name }));
      }
      if (sha256(sbomBytes) !== artifact.sbom.primary.descriptor.sha256) {
        throw new CliError(cliText('package.sbomBytesChanged', { name: artifact.name }));
      }
      const declaration = manifest.artifacts.find((candidate) => candidate.name === artifact.name);
      if (
        !declaration ||
        declaration.fileName !== artifact.fileName ||
        declaration.mediaType !== artifact.contentType ||
        declaration.size !== artifact.size ||
        declaration.sha256 !== artifact.sha256
      ) {
        throw new CliError(cliText('package.metadataDeclaration'));
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
    throw new CliError(cliText('package.keyExactlyOne'));
  }
  let serialized: string | Buffer;
  if (options.privateKeyPath) {
    const keyPath = resolve(options.privateKeyPath);
    const metadata = await stat(keyPath);
    if (!metadata.isFile()) throw new CliError(cliText('package.keyNotFile'));
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw new CliError(cliText('package.keyPermissions'));
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
    throw new CliError(cliText('package.keyFormat'));
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new CliError(cliText('package.keyAlgorithm'));
  return key;
}

function requireWebSigningKeyId(keyId: string | undefined): string {
  if (!keyId || keyId.length > 160) throw new CliError(cliText('package.keyId'));
  return keyId;
}

function signatureEnvelope(keyId: string, bytes: Buffer): PublisherSignature {
  return { algorithm: 'ed25519', keyId, value: bytes.toString('base64') };
}

async function readManifest(path: string): Promise<ReleaseManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  } catch {
    throw new CliError(cliText('error.manifestMissing', { path }));
  }
  const parsed = ReleaseManifestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CliError(
      issue
        ? cliText('error.manifestValidationAt', {
            path: issue.path.join('.') || '/',
            code: issue.code,
          })
        : cliText('error.manifestValidation'),
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
      throw new CliError(cliText('package.artifactMapConflict'));
    }
    if (manifest.kind !== 'desktop') {
      throw new CliError(cliText('package.artifactMapDesktopOnly'));
    }
    if (options.artifactInputs.length === 0) {
      throw new CliError(cliText('package.artifactMapEmpty'));
    }
    const names = new Set<string>();
    for (const input of options.artifactInputs) {
      if (names.has(input.name)) {
        throw new CliError(cliText('package.artifactMapDuplicate', { name: input.name }));
      }
      names.add(input.name);
      if (!manifest.artifacts.some((artifact) => artifact.name === input.name)) {
        throw new CliError(cliText('package.artifactMapUndeclared', { name: input.name }));
      }
    }
    const missing = manifest.artifacts.filter((artifact) => !names.has(artifact.name));
    if (missing.length > 0) {
      throw new CliError(
        cliText('package.artifactMapMissing', {
          names: missing.map((artifact) => artifact.name).join(', '),
        }),
      );
    }
    return [...options.artifactInputs].sort((left, right) => compareCodePoints(left.name, right.name));
  }
  if (!options.inputDirectory) throw new CliError(cliText('package.inputRequired'));
  return [
    { name: selectArtifactName(manifest, options.artifactName), inputDirectory: options.inputDirectory },
  ];
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function selectArtifactName(manifest: ReleaseManifest, requested: string | undefined): string {
  if (manifest.artifacts.length > 1) {
    throw new CliError(cliText('package.multipleArtifacts'));
  }
  if (requested) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requested)) {
      throw new CliError(cliText('package.artifactNameInvalid'));
    }
    const existing = manifest.artifacts[0];
    if (existing && existing.name !== requested) {
      throw new CliError(cliText('package.artifactNameMismatch'));
    }
    return requested;
  }
  if (manifest.artifacts.length === 1) return manifest.artifacts[0]!.name;
  if (manifest.artifacts.length === 0 && manifest.kind === 'web') return 'web-bundle';
  throw new CliError(cliText('package.desktopArtifactRequired'));
}

function updateRuntimeIntegrity(
  manifest: ReleaseManifest,
  entries: readonly ArchiveEntry[],
): ReleaseManifest {
  if (manifest.kind !== 'web' || manifest.runtime !== 'federation') return manifest;
  const fileName = basename(new URL(manifest.manifestUrl).pathname);
  const matches = entries.filter((entry) => entry.name === fileName || entry.name.endsWith(`/${fileName}`));
  if (matches.length !== 1) {
    throw new CliError(cliText('package.federationManifestCount', { fileName }));
  }
  const integritySha256 = sha256(matches[0]!.bytes);
  const manifestUrl = manifest.manifestUrl.replace(FEDERATION_DIGEST_PLACEHOLDER, integritySha256);
  if (!new URL(manifestUrl).pathname.toLowerCase().includes(integritySha256)) {
    throw new CliError(
      cliText('package.federationDigestBinding', { placeholder: FEDERATION_DIGEST_PLACEHOLDER }),
    );
  }
  return { ...manifest, integritySha256, manifestUrl };
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
      throw new CliError(cliText('package.runtimeEntryMissing', { artifactName, entry: runtime.entry }));
  }
}

function omitSbom(artifact: PackagedArtifactMetadata): Omit<PackagedArtifactMetadata, 'sbom'> {
  const { sbom: _sbom, ...metadata } = artifact;
  return metadata;
}

function parsePackageMetadata(value: unknown): PackageMetadata {
  if (!isRecord(value) || typeof value.manifestPath !== 'string') {
    throw new CliError(cliText('package.metadataShape'));
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
      if (names.has(artifact.name)) throw new CliError(cliText('package.metadataDuplicateNames'));
      names.add(artifact.name);
      if (artifact.sbom.primary.path !== artifact.sbom.cyclonedxPath) {
        throw new CliError(cliText('package.primarySbomPath'));
      }
      for (const path of [artifact.path, artifact.sbom.cyclonedxPath, artifact.sbom.spdxPath]) {
        if (paths.has(path)) throw new CliError(cliText('package.metadataDuplicatePaths'));
        paths.add(path);
      }
    }
    return { schemaVersion: 2, manifestPath: value.manifestPath, artifacts };
  }
  throw new CliError(cliText('package.metadataShape'));
}

function parsePackagedArtifact(value: unknown): PackagedArtifactMetadata {
  if (!isRecord(value)) throw new CliError(cliText('package.artifactMetadataShape'));
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
    (value.signature !== undefined && !isPublisherSignature(value.signature))
  ) {
    throw new CliError(cliText('package.artifactMetadataShape'));
  }
  return {
    name: value.name,
    path: value.path,
    fileName: value.fileName,
    contentType: 'application/zip',
    size: value.size,
    sha256: value.sha256,
    ...(value.signature ? { signature: value.signature } : {}),
    sbom,
  };
}

function parseSbomMetadata(value: unknown): PackageSbomMetadata {
  if (!isRecord(value) || !isRecord(value.primary)) {
    throw new CliError(cliText('package.primarySbomMissing'));
  }
  const primary = value.primary;
  if (!isRecord(primary.descriptor)) {
    throw new CliError(cliText('package.primarySbomDescriptorMissing'));
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
    throw new CliError(cliText('package.sbomMetadataShape'));
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
    throw new CliError(cliText('package.unsafeMetadataPath'));
  const components = child.split('/');
  if (components.some((component) => component === '' || component === '.' || component === '..')) {
    throw new CliError(cliText('package.unsafeMetadataPath'));
  }
  const absolute = resolve(directory, ...components);
  const rel = relative(directory, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new CliError(cliText('package.metadataPathEscape'));
  return absolute;
}

function assertOutputOutsideInput(inputDirectory: string, outputDirectory: string): void {
  const rel = relative(inputDirectory, outputDirectory);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new CliError(cliText('package.outputInsideInput'));
  }
}

function remoteName(appId: string): string {
  return `aw_${appId.replace(/-([a-z0-9])/g, (_match, character: string) => character.toUpperCase())}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
