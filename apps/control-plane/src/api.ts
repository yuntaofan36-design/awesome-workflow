import {
  ApplicationSchema,
  CatalogEntrySchema,
  ReleaseListItemSchema,
  ReleaseStatusViewSchema,
  ReviewReleaseInputSchema,
} from '@awesome-workflow/contracts';
import type {
  ApplicationLocalizations,
  ApplicationKind,
  Application,
  ReleaseListItem,
  ReleaseStatus,
  ReleaseStatusView,
  ReviewReleaseInput,
  SupportedLocale,
} from '@awesome-workflow/contracts';
import { WebReleaseManifestSchema } from '@awesome-workflow/manifest-schema';

import type { CatalogEntry, ReleaseChannel, WebManifest } from './domain';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');

export async function listCatalog(
  workspaceId: string,
  channel: ReleaseChannel,
  locale?: SupportedLocale,
): Promise<CatalogEntry[]> {
  const query = new URLSearchParams({ channel, kind: 'web', workspaceId });
  const body = await request<unknown>(`/catalog?${query.toString()}`, undefined, locale);
  return normalizeCatalogResponse(body);
}

export async function createWebApplication(input: {
  defaultLocale: SupportedLocale;
  localizations: ApplicationLocalizations;
  name: string;
  slug: string;
  summary: string;
  workspaceId: string;
  locale?: SupportedLocale;
}): Promise<void> {
  await request(
    `/workspaces/${encodeURIComponent(input.workspaceId)}/applications`,
    {
      body: JSON.stringify({
        defaultLocale: input.defaultLocale,
        kind: 'web',
        localizations: input.localizations,
        name: input.name,
        slug: input.slug,
        summary: input.summary,
      }),
      method: 'POST',
    },
    input.locale,
  );
}

export async function listApplications(
  workspaceId: string,
  locale?: SupportedLocale,
): Promise<Application[]> {
  const body = await request<unknown>(
    `/workspaces/${encodeURIComponent(workspaceId)}/applications`,
    undefined,
    locale,
  );
  const data = isRecord(body) ? body.data : undefined;
  return ApplicationSchema.array().parse(data);
}

export async function listReleases(
  workspaceId: string,
  filters: { kind?: ApplicationKind; status?: ReleaseStatus } = {},
  locale?: SupportedLocale,
): Promise<ReleaseListItem[]> {
  const query = new URLSearchParams();
  if (filters.kind) query.set('kind', filters.kind);
  if (filters.status) query.set('status', filters.status);
  const body = await request<unknown>(
    `/workspaces/${encodeURIComponent(workspaceId)}/releases?${query.toString()}`,
    undefined,
    locale,
  );
  return normalizeReleaseListResponse(body);
}

export async function listPendingReviews(
  workspaceId: string,
  kind?: ApplicationKind,
  locale?: SupportedLocale,
): Promise<ReleaseListItem[]> {
  const query = new URLSearchParams({ workspaceId });
  if (kind) query.set('kind', kind);
  const body = await request<unknown>(`/reviews?${query.toString()}`, undefined, locale);
  return normalizeReleaseListResponse(body);
}

export async function getReleaseStatus(
  releaseId: string,
  locale?: SupportedLocale,
): Promise<ReleaseStatusView> {
  const body = await request<unknown>(`/releases/${encodeURIComponent(releaseId)}/status`, undefined, locale);
  return normalizeReleaseStatusResponse(body);
}

export async function reviewRelease(
  input: ReviewReleaseInput & { releaseId: string; locale?: SupportedLocale },
): Promise<ReleaseStatusView> {
  const review = ReviewReleaseInputSchema.parse({ decision: input.decision, comment: input.comment });
  const body = await request<unknown>(
    `/releases/${encodeURIComponent(input.releaseId)}/reviews`,
    {
      body: JSON.stringify(review),
      method: 'POST',
    },
    input.locale,
  );
  return normalizeReleaseStatusResponse(body);
}

export type ApiProblem = {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  code?: string;
  errors?: unknown;
};

export class ApiProblemError extends Error {
  readonly code: string | undefined;

  constructor(
    readonly status: number,
    readonly problem: ApiProblem,
  ) {
    super(problem.detail || problem.title || `Request failed (${status})`);
    this.name = 'ApiProblemError';
    this.code = problem.code;
  }
}

async function request<T>(path: string, init?: RequestInit, locale?: SupportedLocale): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('accept', 'application/json');
  if (locale) headers.set('accept-language', locale);
  if (init?.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });

  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new ApiProblemError(response.status, parseProblem(body));
  }
  return body as T;
}

function parseProblem(body: unknown): ApiProblem {
  if (!isRecord(body)) return {};
  return {
    ...(typeof body.type === 'string' ? { type: body.type } : {}),
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(typeof body.status === 'number' ? { status: body.status } : {}),
    ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
    ...(typeof body.instance === 'string' ? { instance: body.instance } : {}),
    ...(typeof body.code === 'string' ? { code: body.code } : {}),
    ...(Object.hasOwn(body, 'errors') ? { errors: body.errors } : {}),
  };
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
