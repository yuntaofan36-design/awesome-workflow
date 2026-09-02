import { createHash, randomUUID, verify } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import yauzl, { type Entry, type ZipFile } from 'yauzl';

import type {
  ReleaseValidationJob,
  ReleaseValidationResult,
  ValidationEvidence,
} from '@awesome-workflow/contracts';
import { canonicalizeManifestForSignature, ReleaseManifestSchema } from '@awesome-workflow/manifest-schema';

import type { WorkerConfig } from './config.js';

const VALIDATOR = 'awesome-workflow-worker/0.1.0';

export async function validateRelease(
  job: ReleaseValidationJob,
  config: WorkerConfig,
): Promise<ReleaseValidationResult> {
  const releaseEvidence: ValidationEvidence[] = [];
  try {
    ReleaseManifestSchema.parse(job.manifest);
    releaseEvidence.push(evidence('manifest', 'passed'));
    assertArtifactSetMatchesManifest(job);
    releaseEvidence.push(evidence('manifest', 'passed', { artifactSet: 'matched' }));
    verifyPublisherSignature(
      Buffer.from(canonicalizeManifestForSignature(job.manifest), 'utf8'),
      job.manifest.signature,
      config.signingKeys,
    );
    releaseEvidence.push(evidence('signature', 'passed', { keyId: job.manifest.signature.keyId }));
  } catch (error) {
    releaseEvidence.push(evidence('manifest', 'failed', { reason: safeMessage(error) }));
    return {
      releaseId: job.releaseId,
      success: false,
      artifactResults: job.artifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        success: false,
        error: 'Release manifest validation failed',
        evidence: [],
      })),
      releaseEvidence,
    };
  }

  const validationRoot = await mkdtemp(join(tmpdir(), 'awesome-workflow-validation-'));
  try {
    const artifactResults = [];
    for (const artifact of job.artifacts) {
      artifactResults.push(await validateArtifact(artifact, validationRoot, config));
    }
    return {
      releaseId: job.releaseId,
      success: artifactResults.every((result) => result.success),
      artifactResults,
      releaseEvidence,
    };
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
}

type ArtifactJob = ReleaseValidationJob['artifacts'][number];
type ArtifactResult = ReleaseValidationResult['artifactResults'][number];

async function validateArtifact(
  artifact: ArtifactJob,
  validationRoot: string,
  config: WorkerConfig,
): Promise<ArtifactResult> {
  const checks: ValidationEvidence[] = [];
  let actualSha256: string | undefined;
  let actualSize: number | undefined;
  try {
    const downloaded = await downloadObject(
      artifact.url,
      join(validationRoot, `${artifact.artifactId}.artifact`),
      config.ARTIFACT_MAX_BYTES,
      config.allowedOrigins,
    );
    actualSha256 = downloaded.sha256;
    actualSize = downloaded.size;
    if (actualSize !== artifact.expectedSize) {
      throw new ValidationError('digest', 'Artifact size differs from its immutable declaration');
    }
    if (actualSha256 !== artifact.expectedSha256) {
      throw new ValidationError('digest', 'Artifact SHA-256 differs from its immutable declaration');
    }
    checks.push(evidence('digest', 'passed', { bytes: actualSize, sha256: actualSha256 }));

    verifyPublisherSignature(Buffer.from(actualSha256, 'hex'), artifact.signature, config.signingKeys);
    checks.push(evidence('signature', 'passed', { keyId: artifact.signature.keyId }));

    const sbomUrl = readSbomUrl(artifact.sbom);
    const sbom = await downloadObject(
      sbomUrl,
      join(validationRoot, `${artifact.artifactId}.sbom.json`),
      config.SBOM_MAX_BYTES,
      config.allowedOrigins,
    );
    if (sbom.sha256 !== artifact.sbom.sha256) {
      throw new ValidationError('sbom', 'SBOM SHA-256 differs from its descriptor');
    }
    validateSbomDocument(await readFile(sbom.path), artifact.sbom.format);
    checks.push(evidence('sbom', 'passed', { bytes: sbom.size, format: artifact.sbom.format }));

    if (looksLikeArchive(artifact.url)) {
      const summary = await inspectZipArchive(downloaded.path, {
        maxExpandedBytes: config.ARTIFACT_MAX_EXPANDED_BYTES,
        maxFiles: config.ARTIFACT_MAX_FILES,
      });
      checks.push(evidence('archive', 'passed', summary));
    } else {
      checks.push(evidence('archive', 'passed', { inspected: false, reason: 'not-a-zip-artifact' }));
    }

    return {
      artifactId: artifact.artifactId,
      success: true,
      actualSha256,
      actualSize,
      evidence: checks,
    };
  } catch (error) {
    const check = error instanceof ValidationError ? error.check : 'digest';
    checks.push(evidence(check, 'failed', { reason: safeMessage(error) }));
    return {
      artifactId: artifact.artifactId,
      success: false,
      ...(actualSha256 ? { actualSha256 } : {}),
      ...(actualSize === undefined ? {} : { actualSize }),
      error: safeMessage(error),
      evidence: checks,
    };
  }
}

function assertArtifactSetMatchesManifest(job: ReleaseValidationJob): void {
  const declared = job.manifest.artifacts;
  if (declared.length !== job.artifacts.length) {
    throw new Error('Manifest artifacts and uploaded artifacts differ in count');
  }
  const remaining = [...job.artifacts];
  for (const artifact of declared) {
    const index = remaining.findIndex(
      (candidate) =>
        candidate.fileName === artifact.fileName &&
        candidate.expectedSha256 === artifact.sha256 &&
        candidate.expectedSize === artifact.size,
    );
    if (index < 0) throw new Error(`Manifest artifact ${artifact.name} has no exact uploaded object`);
    remaining.splice(index, 1);
  }
}

async function downloadObject(
  serializedUrl: string,
  path: string,
  maxBytes: number,
  allowedOrigins: ReadonlySet<string>,
): Promise<{ path: string; sha256: string; size: number }> {
  const url = new URL(serializedUrl);
  if (!allowedOrigins.has(url.origin))
    throw new ValidationError('digest', 'Object URL origin is not allowlisted');
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) {
    throw new ValidationError('digest', `Object download failed with status ${response.status}`);
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ValidationError('digest', 'Object exceeds the configured byte limit');
  }

  const destination = await open(path, 'wx', 0o600);
  const hash = createHash('sha256');
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > maxBytes) throw new ValidationError('digest', 'Object exceeds the configured byte limit');
      hash.update(chunk);
      await destination.write(chunk);
    }
  } finally {
    reader.releaseLock();
    await destination.close();
  }
  return { path, sha256: hash.digest('hex'), size };
}

export function verifyPublisherSignature(
  digest: Uint8Array,
  signature: ArtifactJob['signature'],
  keys: ReadonlyMap<string, import('node:crypto').KeyObject>,
): void {
  const key = keys.get(signature.keyId);
  if (!key) throw new ValidationError('signature', 'Publisher signing key is not trusted');
  const bytes = Buffer.from(signature.value, 'base64');
  if (bytes.length !== 64 || !verify(null, digest, key, bytes)) {
    throw new ValidationError('signature', 'Ed25519 signature verification failed');
  }
}

export function validateSbomDocument(bytes: Uint8Array, format: 'cyclonedx-json' | 'spdx-json'): void {
  let document: unknown;
  try {
    document = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new ValidationError('sbom', 'SBOM is not valid JSON');
  }
  if (!isRecord(document)) throw new ValidationError('sbom', 'SBOM root must be an object');
  if (format === 'cyclonedx-json' && document.bomFormat !== 'CycloneDX') {
    throw new ValidationError('sbom', 'CycloneDX SBOM has an invalid bomFormat');
  }
  if (
    format === 'spdx-json' &&
    (typeof document.spdxVersion !== 'string' || !document.spdxVersion.startsWith('SPDX-'))
  ) {
    throw new ValidationError('sbom', 'SPDX SBOM has an invalid spdxVersion');
  }
}

export async function inspectZipArchive(
  path: string,
  limits: { maxExpandedBytes: number; maxFiles: number },
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      { autoClose: true, lazyEntries: true, validateEntrySizes: true },
      (openError, archive) => {
        if (openError || !archive) {
          reject(new ValidationError('archive', openError?.message ?? 'Unable to open ZIP archive'));
          return;
        }
        inspectEntries(archive, limits, resolve, reject);
      },
    );
  });
}

function inspectEntries(
  archive: ZipFile,
  limits: { maxExpandedBytes: number; maxFiles: number },
  resolve: (summary: Record<string, unknown>) => void,
  reject: (reason: unknown) => void,
): void {
  let files = 0;
  let expandedBytes = 0;
  const names = new Set<string>();
  archive.on('entry', (entry: Entry) => {
    try {
      assertSafeArchivePath(entry.fileName);
      const folded = entry.fileName.toLocaleLowerCase('en-US');
      if (names.has(folded))
        throw new ValidationError('archive', 'Archive contains duplicate cross-platform paths');
      names.add(folded);
      if (isZipSymlink(entry)) throw new ValidationError('archive', 'Archive contains a symbolic link');
      if (!entry.fileName.endsWith('/')) files += 1;
      expandedBytes += entry.uncompressedSize;
      if (files > limits.maxFiles)
        throw new ValidationError('archive', 'Archive exceeds the file-count limit');
      if (expandedBytes > limits.maxExpandedBytes) {
        throw new ValidationError('archive', 'Archive exceeds the expanded-size limit');
      }
      archive.readEntry();
    } catch (error) {
      archive.close();
      reject(error);
    }
  });
  archive.once('end', () => resolve({ inspected: true, files, expandedBytes }));
  archive.once('error', (error) => reject(new ValidationError('archive', error.message)));
  archive.readEntry();
}

export function assertSafeArchivePath(name: string): void {
  if (
    !name ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw new ValidationError('archive', 'Archive contains an absolute or invalid path');
  }
  const components = name.split('/').filter(Boolean);
  if (!components.length || components.some((component) => component === '.' || component === '..')) {
    throw new ValidationError('archive', 'Archive path escapes its extraction root');
  }
  for (const component of components) {
    if (component.includes(':') || /[. ]$/.test(component)) {
      throw new ValidationError('archive', 'Archive path is unsafe on Windows');
    }
    const stem = component.split('.')[0]!.toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
      throw new ValidationError('archive', 'Archive path uses a reserved Windows device name');
    }
  }
}

function isZipSymlink(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

function looksLikeArchive(url: string): boolean {
  const pathname = new URL(url).pathname.toLowerCase();
  return pathname.endsWith('.zip') || pathname.endsWith('.awpkg');
}

function readSbomUrl(value: unknown): string {
  if (!isRecord(value) || typeof value.url !== 'string') {
    throw new ValidationError('sbom', 'SBOM object URL is missing from the validation job');
  }
  return value.url;
}

function evidence(
  check: ValidationEvidence['check'],
  outcome: ValidationEvidence['outcome'],
  details: Record<string, unknown> = {},
): ValidationEvidence {
  return {
    id: randomUUID(),
    validator: VALIDATOR,
    check,
    outcome,
    observedAt: new Date().toISOString(),
    details,
  };
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Validation failed';
  return message.replace(/https?:\/\/\S+/gi, '[object-url]').slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

class ValidationError extends Error {
  constructor(
    readonly check: ValidationEvidence['check'],
    message: string,
  ) {
    super(message);
  }
}
