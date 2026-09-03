import { useReducer } from 'react';
import { Alert, Button, Popconfirm, Progress, Space, Tag } from '@arco-design/web-react';
import { IconCloudDownload, IconRefresh, IconSync } from '@arco-design/web-react/icon';

import '@arco-design/web-react/es/Popconfirm/style/css.js';
import '@arco-design/web-react/es/Progress/style/css.js';
import '@arco-design/web-react/es/Tag/style/css.js';

import { isTauriRuntime } from '@/services/desktopHost';
import { formatUiError, normalizeUiError } from '@/i18n/errors';
import { useLocale, type Translate } from '@/i18n/localeContext';
import {
  createInitialUpdateState,
  isUpdateBusy,
  reduceDesktopUpdate,
  updateProgressPercent,
} from '@/services/updateState';

const loadDesktopUpdater = async () => (await import('@/services/desktopUpdater')).desktopUpdater;

export function UpdatePage() {
  const { formatBytes, formatDateTime, t } = useLocale();
  const [state, dispatch] = useReducer(reduceDesktopUpdate, isTauriRuntime(), createInitialUpdateState);
  const progress = updateProgressPercent(state);
  const busy = isUpdateBusy(state.phase);

  const checkForUpdate = async () => {
    dispatch({ type: 'check-started' });
    try {
      const desktopUpdater = await loadDesktopUpdater();
      const update = await desktopUpdater.check();
      dispatch(update ? { type: 'update-available', update } : { type: 'no-update' });
    } catch (error) {
      dispatch({ type: 'failed', error: normalizeUiError(error, 'updater_check_failed') });
    }
  };

  const download = async () => {
    try {
      const desktopUpdater = await loadDesktopUpdater();
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
      dispatch({ type: 'failed', error: normalizeUiError(error, 'updater_download_failed') });
    }
  };

  const install = async () => {
    dispatch({ type: 'install-started' });
    try {
      const desktopUpdater = await loadDesktopUpdater();
      await desktopUpdater.install();
      dispatch({ type: 'installed' });
    } catch (error) {
      dispatch({ type: 'failed', error: normalizeUiError(error, 'updater_install_failed') });
    }
  };

  const restart = async () => {
    try {
      const desktopUpdater = await loadDesktopUpdater();
      await desktopUpdater.restart();
    } catch (error) {
      dispatch({ type: 'failed', error: normalizeUiError(error, 'updater_restart_failed') });
    }
  };

  return (
    <section className="page-stack update-page">
      <header className="page-lead">
        <div>
          <span>07</span>
          <p>{t('updates.eyebrow')}</p>
        </div>
        <h1>{t('updates.title')}</h1>
        <p>{t('updates.description')}</p>
      </header>

      <article className="surface update-console">
        <div className="surface-heading">
          <div>
            <p>{t('updates.state')}</p>
            <h2>{phaseTitle(state.phase, t)}</h2>
          </div>
          <Tag color={phaseColor(state.phase)}>{phaseLabel(state.phase, t)}</Tag>
        </div>

        {state.phase === 'unavailable' && <Alert type="warning" content={t('updates.browserUnavailable')} />}
        {state.phase === 'idle' && <Alert type="info" content={t('updates.idleDescription')} />}
        {state.phase === 'up-to-date' && <Alert type="success" content={t('updates.upToDate')} />}
        {state.phase === 'error' && (
          <Alert type="error" title={t('updates.stopped')} content={formatUiError(state.error, t)} />
        )}

        {state.update && (
          <div className="update-release">
            <div>
              <span>{t('updates.current')}</span>
              <strong>{state.update.currentVersion}</strong>
            </div>
            <i>→</i>
            <div>
              <span>{t('updates.candidate')}</span>
              <strong>{state.update.version}</strong>
            </div>
            {state.update.date && (
              <time dateTime={state.update.date}>{safeFormatDate(state.update.date, formatDateTime)}</time>
            )}
          </div>
        )}

        {state.update?.body && <pre className="update-notes">{state.update.body}</pre>}

        {state.phase === 'downloading' && (
          <div className="update-progress">
            <Progress percent={progress ?? 0} showText={progress !== null} animation />
            <small>
              {progress === null
                ? t('updates.downloaded', { bytes: formatBytes(state.downloadedBytes) })
                : t('updates.signedDownload')}
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
            {t('updates.check')}
          </Button>
          <Button
            type="primary"
            icon={<IconCloudDownload />}
            disabled={state.phase !== 'available'}
            loading={state.phase === 'downloading'}
            onClick={() => void download()}
          >
            {t('updates.download')}
          </Button>
          <Popconfirm
            disabled={state.phase !== 'downloaded'}
            title={t('updates.installConfirm')}
            onOk={() => install()}
          >
            <Button disabled={state.phase !== 'downloaded'} loading={state.phase === 'installing'}>
              {t('updates.install')}
            </Button>
          </Popconfirm>
          <Button
            icon={<IconSync />}
            disabled={state.phase !== 'restart-required'}
            onClick={() => void restart()}
          >
            {t('updates.restart')}
          </Button>
        </Space>
      </article>

      <div className="update-boundaries">
        <article>
          <span>01</span>
          <strong>{t('updates.boundaries.endpointTitle')}</strong>
          <p>{t('updates.boundaries.endpointCopy')}</p>
        </article>
        <article>
          <span>02</span>
          <strong>{t('updates.boundaries.signatureTitle')}</strong>
          <p>{t('updates.boundaries.signatureCopy')}</p>
        </article>
        <article>
          <span>03</span>
          <strong>{t('updates.boundaries.phasesTitle')}</strong>
          <p>{t('updates.boundaries.phasesCopy')}</p>
        </article>
      </div>
    </section>
  );
}

function phaseTitle(phase: string, t: Translate): string {
  switch (phase) {
    case 'idle':
      return t('updates.phaseTitles.idle');
    case 'checking':
      return t('updates.phaseTitles.checking');
    case 'up-to-date':
      return t('updates.phaseTitles.upToDate');
    case 'available':
      return t('updates.phaseTitles.available');
    case 'downloading':
      return t('updates.phaseTitles.downloading');
    case 'downloaded':
      return t('updates.phaseTitles.downloaded');
    case 'installing':
      return t('updates.phaseTitles.installing');
    case 'restart-required':
      return t('updates.phaseTitles.restartRequired');
    case 'error':
      return t('updates.phaseTitles.error');
    default:
      return t('updates.phaseTitles.unavailable');
  }
}

function phaseLabel(phase: string, t: Translate): string {
  const key = phase === 'up-to-date' ? 'upToDate' : phase === 'restart-required' ? 'restartRequired' : phase;
  return t(`updates.phaseLabels.${key}`);
}

function phaseColor(phase: string): 'green' | 'orange' | 'red' | 'gray' | 'arcoblue' {
  if (phase === 'error') return 'red';
  if (phase === 'up-to-date' || phase === 'restart-required') return 'green';
  if (phase === 'available' || phase === 'downloaded') return 'orange';
  if (phase === 'checking' || phase === 'downloading' || phase === 'installing') return 'arcoblue';
  return 'gray';
}

function safeFormatDate(
  value: string,
  formatDateTime: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string,
): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatDateTime(date);
}
