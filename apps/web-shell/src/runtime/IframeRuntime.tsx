import { Spin } from '@arco-design/web-react';
import {
  AW_BRIDGE_VERSION,
  AW_CONNECT_MESSAGE,
  isBridgeReadyMessage,
  type HostApi,
} from '@awesome-workflow/web-sdk';
import { useEffect, useRef, useState } from 'react';

import type { CatalogEntry, IframeManifest } from '../types/catalog';
import { LocalizedErrorAlert } from '../components/LocalizedErrorAlert';
import { useI18n } from '../i18n/I18nProvider';
import { serveHostApi } from './hostApi';

export function IframeRuntime({
  entry,
  host,
}: {
  entry: CatalogEntry & { manifest: IframeManifest };
  host: HostApi;
}) {
  const { t } = useI18n();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<'connecting' | 'error' | 'ready'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const { allowedOrigin } = entry.manifest;

  useEffect(() => {
    if (allowedOrigin === window.location.origin) {
      setError('Iframe micro-apps must run on a separate origin');
      setStatus('error');
      return;
    }

    let bridgeCleanup: (() => void) | undefined;
    let connected = false;
    const onMessage = (event: MessageEvent<unknown>) => {
      const frameWindow = frameRef.current?.contentWindow;
      if (
        connected ||
        !frameWindow ||
        event.source !== frameWindow ||
        event.origin !== allowedOrigin ||
        !isBridgeReadyMessage(event.data)
      ) {
        return;
      }

      connected = true;
      const channel = new MessageChannel();
      bridgeCleanup = serveHostApi(channel.port1, host);
      frameWindow.postMessage({ type: AW_CONNECT_MESSAGE, version: AW_BRIDGE_VERSION }, allowedOrigin, [
        channel.port2,
      ]);
      setStatus('ready');
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      bridgeCleanup?.();
    };
  }, [allowedOrigin, host]);

  return (
    <div className="runtime-frame runtime-frame--iframe">
      {status === 'connecting' && (
        <div className="runtime-overlay runtime-overlay--compact">
          <Spin dot tip={t('runtime.iframeConnecting')} />
        </div>
      )}
      {status === 'error' && (
        <div className="runtime-overlay">
          <LocalizedErrorAlert
            error={error}
            fallbackKey="errors.hostError"
            title={t('runtime.iframeRejected')}
          />
        </div>
      )}
      <iframe
        allow=""
        aria-label={entry.name}
        className="runtime-iframe"
        ref={frameRef}
        referrerPolicy="no-referrer"
        sandbox={entry.manifest.sandbox.join(' ')}
        src={entry.manifest.url}
        title={entry.name}
      />
    </div>
  );
}
