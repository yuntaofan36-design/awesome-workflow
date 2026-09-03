import {
  ReleaseListItemSchema,
  ReleaseStatusViewSchema,
  ReviewReleaseInputSchema,
  type ApplicationKind,
  type ReleaseListItem,
  type ReleaseStatus,
  type ReleaseStatusView,
  type ReviewReleaseInput,
  type SupportedLocale,
} from '@awesome-workflow/contracts';

import { isRecord, request } from '../apiClient';

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
    { body: JSON.stringify(review), method: 'POST' },
    input.locale,
  );
  return normalizeReleaseStatusResponse(body);
}

export function normalizeReleaseStatusResponse(body: unknown): ReleaseStatusView {
  const data = isRecord(body) ? body.data : undefined;
  return ReleaseStatusViewSchema.parse(data);
}

export function normalizeReleaseListResponse(body: unknown): ReleaseListItem[] {
  const data = isRecord(body) ? body.data : undefined;
  return ReleaseListItemSchema.array().parse(data);
}
