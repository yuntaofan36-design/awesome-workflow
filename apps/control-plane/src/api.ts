import {
  ApplicationSchema,
  CatalogEntrySchema,
  ReleaseListItemSchema,
  ReleaseStatusViewSchema,
  ReviewReleaseInputSchema,
} from '@awesome-workflow/contracts';
import type {
  ApplicationKind,
  Application,
  ReleaseListItem,
  ReleaseStatus,
  ReleaseStatusView,
  ReviewReleaseInput,
} from '@awesome-workflow/contracts';
import { WebReleaseManifestSchema } from '@awesome-workflow/manifest-schema';

import type { CatalogEntry, ReleaseChannel, WebManifest } from './domain';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');

export async function listCatalog(workspaceId: string, channel: ReleaseChannel): Promise<CatalogEntry[]> {
  const query = new URLSearchParams({ channel, kind: 'web', workspaceId });
  const body = await request<unknown>(`/catalog?${query.toString()}`);
  return normalizeCatalogResponse(body);
}

export async function createWebApplication(input: {
  name: string;
  slug: string;
  summary: string;
  workspaceId: string;
}): Promise<void> {
  await request(`/workspaces/${encodeURIComponent(input.workspaceId)}/applications`, {
    body: JSON.stringify({ kind: 'web', name: input.name, slug: input.slug, summary: input.summary }),
    method: 'POST',
  });
}

export async function listApplications(workspaceId: string): Promise<Application[]> {
  const body = await request<unknown>(`/workspaces/${encodeURIComponent(workspaceId)}/applications`);
  const data = isRecord(body) ? body.data : undefined;
  return ApplicationSchema.array().parse(data);
}

export async function listReleases(
  workspaceId: string,
  filters: { kind?: ApplicationKind; status?: ReleaseStatus } = {},
): Promise<ReleaseListItem[]> {
  const query = new URLSearchParams();
  if (filters.kind) query.set('kind', filters.kind);
  if (filters.status) query.set('status', filters.status);
  const body = await request<unknown>(
    `/workspaces/${encodeURIComponent(workspaceId)}/releases?${query.toString()}`,
  );
  return normalizeReleaseListResponse(body);
}

export async function listPendingReviews(
  workspaceId: string,
  kind?: ApplicationKind,
): Promise<ReleaseListItem[]> {
  const query = new URLSearchParams({ workspaceId });
  if (kind) query.set('kind', kind);
  const body = await request<unknown>(`/reviews?${query.toString()}`);
  return normalizeReleaseListResponse(body);
}

export async function getReleaseStatus(releaseId: string): Promise<ReleaseStatusView> {
  const body = await request<unknown>(`/releases/${encodeURIComponent(releaseId)}/status`);
  return normalizeReleaseStatusResponse(body);
}

export async function reviewRelease(
  input: ReviewReleaseInput & { releaseId: string },
): Promise<ReleaseStatusView> {
  const review = ReviewReleaseInputSchema.parse({ decision: input.decision, comment: input.comment });
  const body = await request<unknown>(`/releases/${encodeURIComponent(input.releaseId)}/reviews`, {
    body: JSON.stringify(review),
    method: 'POST',
  });
  return normalizeReleaseStatusResponse(body);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = isRecord(body)
      ? (typeof body.detail === 'string' && body.detail) ||
        (typeof body.title === 'string' && body.title) ||
        (typeof body.message === 'string' && body.message) ||
        `Request failed (${response.status})`
      : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export function normalizeCatalogResponse(body: unknown): CatalogEntry[] {
  const data = isRecord(body) ? body.data : undefined;
  if (!Array.isArray(data)) {
    throw new Error('Catalog response does not contain a data array');
  }
  return CatalogEntrySchema.array()
    .parse(data)
    .map((entry) => {
      if (entry.kind !== 'web' || entry.manifest.kind !== 'web')
        throw new Error('Web catalog returned a non-web release');
      return { ...entry, kind: 'web', manifest: WebReleaseManifestSchema.parse(entry.manifest) };
    });
}

export function normalizeReleaseStatusResponse(body: unknown): ReleaseStatusView {
  const data = isRecord(body) ? body.data : undefined;
  return ReleaseStatusViewSchema.parse(data);
}

export function normalizeReleaseListResponse(body: unknown): ReleaseListItem[] {
  const data = isRecord(body) ? body.data : undefined;
  return ReleaseListItemSchema.array().parse(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
