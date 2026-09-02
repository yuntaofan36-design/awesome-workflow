import { useReducer } from 'react';
import { Alert, Button, Popconfirm, Progress, Space, Tag } from '@arco-design/web-react';
import { IconCloudDownload, IconRefresh, IconSync } from '@arco-design/web-react/icon';

import { isTauriRuntime } from '@/services/desktopHost';
import { desktopUpdater } from '@/services/desktopUpdater';
import {
  createInitialUpdateState,
  isUpdateBusy,
  reduceDesktopUpdate,
  updateProgressPercent,
} from '@/services/updateState';

export function UpdatePage() {
  const [state, dispatch] = useReducer(reduceDesktopUpdate, isTauriRuntime(), createInitialUpdateState);
  const progress = updateProgressPercent(state);
  const busy = isUpdateBusy(state.phase);

  const checkForUpdate = async () => {
    dispatch({ type: 'check-started' });
    try {
      const update = await desktopUpdater.check();
      dispatch(update ? { type: 'update-available', update } : { type: 'no-update' });
    } catch (error) {
      dispatch({ type: 'failed', error: describe(error) });
    }
  };

  const download = async () => {
    try {
      await desktopUpdater.download((event) => {
        if (event.type === 'started') {
          dispatch({ type: 'download-started', contentLength: event.contentLength });
        } else if (event.type === 'progress') {
          dispatch({ type: 'download-progress', chunkLength: event.chunkLength });
        } else {
          dispatch({ type: 'download-finished' });
        }
      });
    } catch (error) {
      dispatch({ type: 'failed', error: describe(error) });
    }
  };

  const install = async () => {
    dispatch({ type: 'install-started' });
    try {
      await desktopUpdater.install();
      dispatch({ type: 'installed' });
    } catch (error) {
      dispatch({ type: 'failed', error: describe(error) });
    }
  };

  const restart = async () => {
    try {
      await desktopUpdater.restart();
    } catch (error) {
      dispatch({ type: 'failed', error: describe(error) });
    }
  };

  return (
    <section className="page-stack update-page">
      <header className="page-lead">
        <div>
          <span>07</span>
          <p>SIGNED HOST DELIVERY</p>
        </div>
        <h1>Desktop updates</h1>
        <p>
          Checks use the HTTPS endpoint and updater public key fixed into this binary at release build time.
          The UI cannot enter or override an endpoint, proxy, header, target, or signing key.
        </p>
      </header>

      <article className="surface update-console">
        <div className="surface-heading">
          <div>
            <p>UPDATE STATE</p>
            <h2>{phaseTitle(state.phase)}</h2>
          </div>
          <Tag color={phaseColor(state.phase)}>{state.phase.replaceAll('-', ' ').toUpperCase()}</Tag>
        </div>

        {state.phase === 'unavailable' && (
          <Alert type="warning" content="Updater commands are unavailable in browser preview mode." />
        )}
        {state.phase === 'idle' && (
          <Alert
            type="info"
            content="Updates are never checked automatically. If this release was built without endpoint or public-key configuration, the check fails closed."
          />
        )}
        {state.phase === 'up-to-date' && <Alert type="success" content="This signed build is up to date." />}
        {state.phase === 'error' && (
          <Alert type="error" title="Update stopped" content={state.error ?? 'Unknown error'} />
        )}

        {state.update && (
          <div className="update-release">
            <div>
              <span>CURRENT</span>
              <strong>{state.update.currentVersion}</strong>
            </div>
            <i>→</i>
            <div>
              <span>SIGNED CANDIDATE</span>
              <strong>{state.update.version}</strong>
            </div>
            {state.update.date && <time dateTime={state.update.date}>{formatDate(state.update.date)}</time>}
          </div>
        )}

        {state.update?.body && <pre className="update-notes">{state.update.body}</pre>}

        {state.phase === 'downloading' && (
          <div className="update-progress">
            <Progress percent={progress ?? 0} showText={progress !== null} animation />
            <small>
              {progress === null
                ? `${formatBytes(state.downloadedBytes)} downloaded`
                : 'Signed package download'}
            </small>
          </div>
        )}

        <Space className="update-actions" wrap>
          <Button
            icon={<IconRefresh />}
            disabled={state.phase === 'unavailable' || busy}
            loading={state.phase === 'checking'}
            onClick={() => void checkForUpdate()}
          >
            Check explicitly
          </Button>
          <Button
            type="primary"
            icon={<IconCloudDownload />}
            disabled={state.phase !== 'available'}
            loading={state.phase === 'downloading'}
            onClick={() => void download()}
          >
            Download signed update
          </Button>
          <Popconfirm
            disabled={state.phase !== 'downloaded'}
            title="Install the downloaded update? Windows may close this UI while its installer runs."
            onOk={() => install()}
          >
            <Button disabled={state.phase !== 'downloaded'} loading={state.phase === 'installing'}>
              Install update
            </Button>
          </Popconfirm>
          <Button
            icon={<IconSync />}
            disabled={state.phase !== 'restart-required'}
            onClick={() => void restart()}
          >
            Restart now
          </Button>
        </Space>
      </article>

      <div className="update-boundaries">
        <article>
          <span>01</span>
          <strong>Fixed endpoint</strong>
          <p>
            Only the release-build updater configuration is consulted; there is no arbitrary URL API in this
            UI.
          </p>
        </article>
        <article>
          <span>02</span>
          <strong>Signature before install</strong>
          <p>Tauri verifies the downloaded updater artifact against the embedded updater public key.</p>
        </article>
        <article>
          <span>03</span>
          <strong>User-controlled phases</strong>
          <p>
            Check, download, install, and relaunch are separate user actions rather than background side
            effects.
          </p>
        </article>
      </div>
    </section>
  );
}

function phaseTitle(phase: string): string {
  switch (phase) {
    case 'idle':
      return 'Ready for an explicit check';
    case 'checking':
      return 'Checking signed release metadata';
    case 'up-to-date':
      return 'No newer release';
    case 'available':
      return 'A signed candidate is available';
    case 'downloading':
      return 'Downloading updater artifact';
    case 'downloaded':
      return 'Download complete';
    case 'installing':
      return 'Installing update';
    case 'restart-required':
      return 'Restart required';
    case 'error':
      return 'Fail-closed stop';
    default:
      return 'Updater unavailable';
  }
}

function phaseColor(phase: string): 'green' | 'orange' | 'red' | 'gray' | 'arcoblue' {
  if (phase === 'error') return 'red';
  if (phase === 'up-to-date' || phase === 'restart-required') return 'green';
  if (phase === 'available' || phase === 'downloaded') return 'orange';
  if (phase === 'checking' || phase === 'downloading' || phase === 'installing') return 'arcoblue';
  return 'gray';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
