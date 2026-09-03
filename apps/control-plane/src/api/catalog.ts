import { CatalogEntrySchema, type SupportedLocale } from '@awesome-workflow/contracts';
import { WebReleaseManifestSchema } from '@awesome-workflow/manifest-schema';

import { isRecord, request } from '../apiClient';
import type { CatalogEntry, ReleaseChannel } from '../domain';

export async function listCatalog(
  workspaceId: string,
  channel: ReleaseChannel,
  locale?: SupportedLocale,
): Promise<CatalogEntry[]> {
  const query = new URLSearchParams({ channel, kind: 'web', workspaceId });
  const body = await request<unknown>(`/catalog?${query.toString()}`, undefined, locale);
  return normalizeCatalogResponse(body);
}

export function normalizeCatalogResponse(body: unknown): CatalogEntry[] {
  const data = isRecord(body) ? body.data : undefined;
  if (!Array.isArray(data)) throw new Error('Catalog response does not contain a data array');
  return CatalogEntrySchema.array()
    .parse(data)
    .map((entry) => {
      if (entry.kind !== 'web' || entry.manifest.kind !== 'web') {
        throw new Error('Web catalog returned a non-web release');
      }
      return { ...entry, kind: 'web', manifest: WebReleaseManifestSchema.parse(entry.manifest) };
    });
}
