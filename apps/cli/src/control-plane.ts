import type { CatalogEntry, ReleaseChannelName, ReleaseStatusView } from '@awesome-workflow/contracts';

import { ApiClient, type UploadTarget } from './api-client.js';
import { readPackageMetadata } from './package-release.js';
import { CliError, isRecord } from './safety.js';

export type PublishSummary = {
  releaseId: string;
  version: string;
  status: string;
  artifacts: Array<{ fileName: string; status: string }>;
};

export async function publishPackagedRelease(options: {
  api: ApiClient;
  applicationId: string;
  metadataPath: string;
}): Promise<PublishSummary> {
  const packaged = await readPackageMetadata(options.metadataPath);
  const createdRelease = await options.api.request<unknown>(
    'POST',
    `/applications/${encodeURIComponent(options.applicationId)}/releases`,
    {
      version: packaged.manifest.version,
      manifest: packaged.manifest,
      signature: packaged.manifest.signature,
      // Release.sbom is retained for API v1 compatibility. Validation consumes
      // the per-artifact SBOM descriptors uploaded below.
      sbom: packaged.artifacts[0]!.metadata.sbom.primary.descriptor,
    },
  );
  const releaseId = readId(createdRelease, 'release');
  for (const packagedArtifact of packaged.artifacts) {
    const artifact = packagedArtifact.metadata;
    const intentValue = await options.api.request<unknown>(
      'POST',
      `/releases/${encodeURIComponent(releaseId)}/artifacts`,
      {
        fileName: artifact.fileName,
        contentType: artifact.contentType,
        size: artifact.size,
        sha256: artifact.sha256,
        signature: artifact.signature,
        sbom: artifact.sbom.primary.descriptor,
      },
    );
    const intent = parseUploadIntent(intentValue);
    const artifactEtag = await options.api.upload(intent.upload, packagedArtifact.artifactBytes, 'artifact');
    await options.api.upload(intent.sbomUpload, packagedArtifact.sbomBytes, 'SBOM');
    await options.api.request<unknown>(
      'POST',
      `/artifacts/${encodeURIComponent(intent.artifactId)}/finalize`,
      {
        ...(artifactEtag ? { etag: artifactEtag } : {}),
      },
    );
  }
  const submitted = await options.api.request<unknown>(
    'POST',
    `/releases/${encodeURIComponent(releaseId)}/submit`,
  );
  return summarizeReleaseStatus(submitted, releaseId, packaged.manifest.version);
}

export async function promoteRelease(options: {
  api: ApiClient;
  applicationId: string;
  releaseId: string;
  channel: ReleaseChannelName;
  expectedCurrentReleaseId?: string | null;
  workspaceId?: string;
}): Promise<{ applicationId: string; releaseId: string; version?: string; channel: string }> {
  let expected = options.expectedCurrentReleaseId;
  if (expected === undefined) {
    if (!options.workspaceId) {
      throw new CliError(
        'Promotion requires --expected-current-release-id, --expected-none, or --workspace-id to derive the current channel revision.',
      );
    }
    const query = new URLSearchParams({ workspaceId: options.workspaceId, channel: options.channel });
    const catalog = await options.api.request<unknown>('GET', `/catalog?${query.toString()}`);
    if (!Array.isArray(catalog)) throw new CliError('Catalog response is invalid.');
    const current = catalog.find(
      (entry): entry is CatalogEntry => isRecord(entry) && entry.applicationId === options.applicationId,
    );
    expected = current?.releaseId ?? null;
  }
  const promoted = await options.api.request<unknown>(
    'POST',
    `/applications/${encodeURIComponent(options.applicationId)}/channels/${encodeURIComponent(options.channel)}/promote`,
    { releaseId: options.releaseId, expectedCurrentReleaseId: expected },
  );
  if (!isRecord(promoted)) throw new CliError('Promotion response is invalid.');
  return {
    applicationId:
      typeof promoted.applicationId === 'string' ? promoted.applicationId : options.applicationId,
    releaseId: typeof promoted.releaseId === 'string' ? promoted.releaseId : options.releaseId,
    ...(typeof promoted.version === 'string' ? { version: promoted.version } : {}),
    channel: typeof promoted.channel === 'string' ? promoted.channel : options.channel,
  };
}

export async function releaseStatus(options: { api: ApiClient; releaseId: string }): Promise<{
  release: { id: string; version: string; status: string };
  artifacts: Array<{ fileName: string; status: string }>;
  reviews: Array<{ decision: string; createdAt: string }>;
}> {
  const value = await options.api.request<unknown>(
    'GET',
    `/releases/${encodeURIComponent(options.releaseId)}/status`,
  );
  if (
    !isRecord(value) ||
    !isRecord(value.release) ||
    !Array.isArray(value.artifacts) ||
    !Array.isArray(value.reviews)
  ) {
    throw new CliError('Release status response is invalid.');
  }
  return {
    release: {
      id: readString(value.release, 'id', options.releaseId),
      version: readString(value.release, 'version'),
      status: readString(value.release, 'status'),
    },
    artifacts: value.artifacts.map((artifact) => {
      if (!isRecord(artifact)) throw new CliError('Release artifact status is invalid.');
      return { fileName: readString(artifact, 'fileName'), status: readString(artifact, 'status') };
    }),
    reviews: value.reviews.map((review) => {
      if (!isRecord(review)) throw new CliError('Release review status is invalid.');
      return { decision: readString(review, 'decision'), createdAt: readString(review, 'createdAt') };
    }),
  };
}

function parseUploadIntent(value: unknown): {
  artifactId: string;
  upload: UploadTarget;
  sbomUpload: UploadTarget;
} {
  if (!isRecord(value) || !isRecord(value.artifact)) throw new CliError('Artifact upload intent is invalid.');
  const upload = parseUploadTarget(value.upload, 'artifact');
  if (!Object.hasOwn(value, 'sbomUpload')) {
    throw new CliError(
      'Server did not provide an SBOM upload intent. Publishing stopped before finalize; the current release API cannot safely accept this package.',
    );
  }
  const sbomUpload = parseUploadTarget(value.sbomUpload, 'SBOM');
  return { artifactId: readString(value.artifact, 'id'), upload, sbomUpload };
}

function parseUploadTarget(value: unknown, label: string): UploadTarget {
  if (
    !isRecord(value) ||
    value.method !== 'PUT' ||
    typeof value.url !== 'string' ||
    !isRecord(value.headers) ||
    typeof value.expiresAt !== 'string'
  ) {
    throw new CliError(`${label} upload intent is invalid.`);
  }
  const headers: Record<string, string> = {};
  for (const [key, header] of Object.entries(value.headers)) {
    if (typeof header !== 'string') throw new CliError(`${label} upload headers are invalid.`);
    headers[key] = header;
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new CliError(`${label} upload URL is invalid.`);
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new CliError(`${label} upload URL must use HTTP(S).`);
  const expiry = new Date(value.expiresAt);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
    throw new CliError(`${label} upload intent is already expired.`);
  }
  return { method: 'PUT', url: url.toString(), headers, expiresAt: value.expiresAt };
}

function summarizeReleaseStatus(value: unknown, releaseId: string, version: string): PublishSummary {
  if (!isRecord(value) || !isRecord(value.release) || !Array.isArray(value.artifacts)) {
    throw new CliError('Submit response is invalid.');
  }
  return {
    releaseId: readString(value.release, 'id', releaseId),
    version: readString(value.release, 'version', version),
    status: readString(value.release, 'status'),
    artifacts: value.artifacts.map((artifact) => {
      if (!isRecord(artifact)) throw new CliError('Submit artifact response is invalid.');
      return { fileName: readString(artifact, 'fileName'), status: readString(artifact, 'status') };
    }),
  };
}

function readId(value: unknown, label: string): string {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
    throw new CliError(`Create ${label} response did not include an id.`);
  }
  return value.id;
}

function readString(value: Record<string, unknown>, key: string, fallback?: string): string {
  const candidate = value[key];
  if (typeof candidate === 'string') return candidate;
  if (fallback !== undefined) return fallback;
  throw new CliError(`Response field ${key} is missing.`);
}
