import { Spin } from '@arco-design/web-react';
import type { HostApi } from '@awesome-workflow/web-sdk';
import { lazy, Suspense } from 'react';

import { useI18n } from '../i18n/I18nProvider';
import type { CatalogEntry, FederationManifest, IframeManifest, LinkManifest } from '../types/catalog';

const FederationRuntime = lazy(async () => {
  const module = await import('./FederationRuntime');
  return { default: module.FederationRuntime };
});
const IframeRuntime = lazy(async () => {
  const module = await import('./IframeRuntime');
  return { default: module.IframeRuntime };
});
const LinkRuntime = lazy(async () => {
  const module = await import('./LinkRuntime');
  return { default: module.LinkRuntime };
});

export function RuntimeSurface({ entry, host }: { entry: CatalogEntry; host: HostApi }) {
  const { t } = useI18n();
  let runtime: React.ReactNode;
  switch (entry.manifest.runtime) {
    case 'federation':
      runtime = (
        <FederationRuntime entry={entry as CatalogEntry & { manifest: FederationManifest }} host={host} />
      );
      break;
    case 'iframe':
      runtime = <IframeRuntime entry={entry as CatalogEntry & { manifest: IframeManifest }} host={host} />;
      break;
    case 'link':
      runtime = <LinkRuntime entry={entry as CatalogEntry & { manifest: LinkManifest }} />;
      break;
  }
  return (
    <Suspense
      fallback={
        <div className="runtime-frame" role="status" aria-live="polite" aria-busy="true">
          <div className="runtime-overlay">
            <Spin dot tip={t('asyncFailure.runtimeLoading')} />
          </div>
        </div>
      }
    >
      {runtime}
    </Suspense>
  );
}
