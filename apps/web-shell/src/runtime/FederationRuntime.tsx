import { Button, Spin } from '@arco-design/web-react';
import type { HostApi } from '@awesome-workflow/web-sdk';
import { useEffect, useRef, useState } from 'react';

import type { CatalogEntry, FederationManifest } from '../types/catalog';
import { LocalizedErrorAlert } from '../components/LocalizedErrorAlert';
import { useI18n } from '../i18n/I18nProvider';
import { loadFederationModule } from './federation';
import { runtimeReleaseKey } from './lifecycle';

type Phase = { error?: unknown; status: 'error' | 'loading' | 'ready' };

export function FederationRuntime({
  entry,
  host,
}: {
  entry: CatalogEntry & { manifest: FederationManifest };
  host: HostApi;
}) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ status: 'loading' });
  const mountKey = runtimeReleaseKey(entry);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    let loadedModule: Awaited<ReturnType<typeof loadFederationModule>> | undefined;
    setPhase({ status: 'loading' });

    void loadFederationModule(entry)
      .then(async (module) => {
        if (disposed) return;
        loadedModule = module;
        const mountResult = await module.mount(container, host);
        if (typeof mountResult === 'function') cleanup = mountResult;
        if (!disposed) setPhase({ status: 'ready' });
      })
      .catch((error: unknown) => {
        if (!disposed) setPhase({ error, status: 'error' });
      });

    return () => {
      disposed = true;
      cleanup?.();
      if (loadedModule) void loadedModule.unmount(container);
    };
    // Catalog metadata is localized independently. Code is immutable for this
    // release key, so presentation changes must not run the unmount cleanup.
  }, [attempt, host, mountKey]);

  return (
    <div className="runtime-frame runtime-frame--federation">
      {phase.status === 'loading' && (
        <div className="runtime-overlay">
          <Spin dot tip={t('runtime.federationLoading')} />
        </div>
      )}
      {phase.status === 'error' && (
        <div className="runtime-overlay">
          <LocalizedErrorAlert
            error={phase.error}
            fallbackKey="errors.hostError"
            title={t('runtime.federationRejected')}
          />
          <Button onClick={() => setAttempt((value) => value + 1)}>{t('common.retry')}</Button>
        </div>
      )}
      <div className="runtime-mount" ref={containerRef} aria-busy={phase.status === 'loading'} />
    </div>
  );
}
