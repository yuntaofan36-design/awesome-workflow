import { Alert, Button, Spin } from '@arco-design/web-react';
import type { HostApi } from '@awesome-workflow/web-sdk';
import { useEffect, useRef, useState } from 'react';

import type { CatalogEntry, FederationManifest } from '../types/catalog';
import { loadFederationModule } from './federation';

type Phase = { error?: string; status: 'error' | 'loading' | 'ready' };

export function FederationRuntime({
  entry,
  host,
}: {
  entry: CatalogEntry & { manifest: FederationManifest };
  host: HostApi;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ status: 'loading' });

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
        if (!disposed)
          setPhase({ error: error instanceof Error ? error.message : 'Remote load failed', status: 'error' });
      });

    return () => {
      disposed = true;
      cleanup?.();
      if (loadedModule) void loadedModule.unmount(container);
    };
  }, [attempt, entry, host]);

  return (
    <div className="runtime-frame runtime-frame--federation">
      {phase.status === 'loading' && (
        <div className="runtime-overlay">
          <Spin dot tip="Loading trusted federation remote…" />
        </div>
      )}
      {phase.status === 'error' && (
        <div className="runtime-overlay">
          <Alert type="error" title="Federation remote rejected" content={phase.error} />
          <Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
        </div>
      )}
      <div className="runtime-mount" ref={containerRef} aria-busy={phase.status === 'loading'} />
    </div>
  );
}
