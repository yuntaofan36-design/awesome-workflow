import type { HostApi } from '@awesome-workflow/web-sdk';

import type { CatalogEntry, FederationManifest, IframeManifest, LinkManifest } from '../types/catalog';
import { FederationRuntime } from './FederationRuntime';
import { IframeRuntime } from './IframeRuntime';
import { LinkRuntime } from './LinkRuntime';

export function RuntimeSurface({ entry, host }: { entry: CatalogEntry; host: HostApi }) {
  switch (entry.manifest.runtime) {
    case 'federation':
      return (
        <FederationRuntime entry={entry as CatalogEntry & { manifest: FederationManifest }} host={host} />
      );
    case 'iframe':
      return <IframeRuntime entry={entry as CatalogEntry & { manifest: IframeManifest }} host={host} />;
    case 'link':
      return <LinkRuntime entry={entry as CatalogEntry & { manifest: LinkManifest }} />;
  }
}
