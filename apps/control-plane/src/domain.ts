import type { CatalogEntry as ContractCatalogEntry, ReleaseChannelName } from '@awesome-workflow/contracts';
import type { WebReleaseManifest } from '@awesome-workflow/manifest-schema';

export type ReleaseChannel = ReleaseChannelName;
export type WebManifest = WebReleaseManifest;
export type FederationManifest = Extract<WebManifest, { runtime: 'federation' }>;
export type IframeManifest = Extract<WebManifest, { runtime: 'iframe' }>;
export type LinkManifest = Extract<WebManifest, { runtime: 'link' }>;
export type CatalogEntry = Omit<ContractCatalogEntry, 'kind' | 'manifest'> & {
  kind: 'web';
  manifest: WebManifest;
};

export function groupByChannel(entries: readonly CatalogEntry[]): Record<ReleaseChannel, CatalogEntry[]> {
  return entries.reduce<Record<ReleaseChannel, CatalogEntry[]>>(
    (groups, entry) => {
      groups[entry.channel].push(entry);
      return groups;
    },
    { canary: [], dev: [], stable: [] },
  );
}
