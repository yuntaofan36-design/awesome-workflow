import type { CatalogEntry } from '../types/catalog';

/** An immutable release is the unit of code mounting and unmounting. */
export function runtimeReleaseKey(entry: Pick<CatalogEntry, 'applicationId' | 'releaseId'>): string {
  return `${entry.applicationId}:${entry.releaseId}`;
}

/** User and workspace changes are authorization-boundary changes. */
export function runtimeScopeKey(
  entry: Pick<CatalogEntry, 'applicationId' | 'releaseId'>,
  userId: string,
  workspaceId: string,
): string {
  return `${userId}:${workspaceId}:${runtimeReleaseKey(entry)}`;
}
