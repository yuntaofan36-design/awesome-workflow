import { useMemo, useState } from 'react';
import { Alert, Button, Empty, Input, Message, Tag } from '@arco-design/web-react';
import { IconCode, IconCopy, IconFolder, IconPlayArrow } from '@arco-design/web-react/icon';

import { capabilityLabel, platformLabel, runtimeLabel } from '@/i18n/domain';
import { formatUiError, normalizeUiError } from '@/i18n/errors';
import { useLocale } from '@/i18n/localeContext';
import { desktopHost } from '@/services/desktopHost';
import {
  selectDesktopLoading,
  selectRegisterDirectory,
  selectRunApplet,
  selectSnapshot,
  selectValidateDirectory,
  selectValidatedManifest,
  useDesktopStore,
} from '@/stores/desktopStore';
import { useDeveloperContext } from './developerContext';

export function DeveloperDevelopPage() {
  const { selectedApplication } = useDeveloperContext();
  const { resolveApplicationContent, t } = useLocale();
  const snapshot = useDesktopStore(selectSnapshot);
  const manifest = useDesktopStore(selectValidatedManifest);
  const loading = useDesktopStore(selectDesktopLoading);
  const validate = useDesktopStore(selectValidateDirectory);
  const register = useDesktopStore(selectRegisterDirectory);
  const run = useDesktopStore(selectRunApplet);
  const [directory, setDirectory] = useState('');
  const localVersions = useMemo(
    () => snapshot?.installed.filter((item) => item.manifest.appId === selectedApplication?.slug) ?? [],
    [selectedApplication?.slug, snapshot?.installed],
  );
  const identityMatches = Boolean(manifest && manifest.appId === selectedApplication?.slug);

  const chooseDirectory = async () => {
    const selected = await desktopHost.chooseDirectory(t('developerPlatform.develop.chooseDirectory'));
    if (!selected) return;
    setDirectory(selected);
    await validate(selected);
  };

  if (!selectedApplication) return <SelectApplicationEmpty />;

  return (
    <div className="developer-route">
      <div className="developer-section-heading">
        <div>
          <span>{t('developerPlatform.develop.eyebrow')}</span>
          <h2>{t('developerPlatform.develop.title', { name: selectedApplication.name })}</h2>
          <p>{t('developerPlatform.develop.description')}</p>
        </div>
        <Tag color={snapshot?.developerMode ? 'green' : 'orange'}>
          {snapshot?.developerMode
            ? t('developerPlatform.develop.modeReady')
            : t('developerPlatform.develop.modeUnavailable')}
        </Tag>
      </div>

      {!snapshot?.developerMode && <Alert type="warning" content={t('developerPlatform.develop.modeHelp')} />}

      <div className="developer-workbench-grid">
        <article className="surface developer-workbench-card">
          <div className="developer-card-heading">
            <span>01</span>
            <div>
              <small>{t('developerPlatform.develop.source')}</small>
              <h3>{t('developerPlatform.develop.linkDirectory')}</h3>
            </div>
            <IconFolder />
          </div>
          <div className="developer-path-picker">
            <Input
              value={directory}
              onChange={setDirectory}
              placeholder={t('developerPlatform.develop.directoryPlaceholder')}
            />
            <Button onClick={() => void chooseDirectory()}>{t('common.browse')}</Button>
          </div>
          {manifest ? (
            <div className="developer-manifest-summary">
              <div>
                <strong>{resolveApplicationContent(manifest, manifest.localizations).name}</strong>
                <code>
                  {manifest.appId}@{manifest.version}
                </code>
              </div>
              <div className="developer-chip-row">
                {manifest.runtimes.map((runtime) => (
                  <Tag key={`${runtime.platform.os}-${runtime.platform.arch}-${runtime.kind}`}>
                    {platformLabel(runtime.platform, t)} / {runtimeLabel(runtime.kind, t)}
                  </Tag>
                ))}
              </div>
              <div className="developer-chip-row">
                {manifest.capabilities.length === 0 ? (
                  <small>{t('developerPlatform.develop.noCapabilities')}</small>
                ) : (
                  manifest.capabilities.map((capability, index) => (
                    <code key={`${capability.kind}-${index}`}>{capabilityLabel(capability, t)}</code>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="developer-drop-zone">
              <IconCode />
              <span>{t('developerPlatform.develop.validationHint')}</span>
            </div>
          )}
          {manifest && !identityMatches && (
            <Alert
              type="error"
              content={t('developerPlatform.develop.identityMismatch', {
                actual: manifest.appId,
                expected: selectedApplication.slug,
              })}
            />
          )}
          <Button
            type="primary"
            loading={loading}
            disabled={!snapshot?.developerMode || !directory || !identityMatches}
            onClick={() => {
              void register(directory)
                .then(() => Message.success(t('developerPlatform.develop.linked')))
                .catch((error: unknown) =>
                  Message.error(
                    formatUiError(normalizeUiError(error, 'development_applet_registration_failed'), t),
                  ),
                );
            }}
          >
            {t('developerPlatform.develop.link')}
          </Button>
        </article>

        <article className="surface developer-workbench-card">
          <div className="developer-card-heading">
            <span>02</span>
            <div>
              <small>{t('developerPlatform.develop.manifest')}</small>
              <h3>{t('developerPlatform.develop.manifestTitle')}</h3>
            </div>
            <Button
              shape="circle"
              type="text"
              icon={<IconCopy />}
              disabled={!manifest}
              aria-label={t('developerPlatform.develop.copyManifest')}
              onClick={() => {
                if (!manifest) return;
                void navigator.clipboard
                  .writeText(JSON.stringify(manifest, null, 2))
                  .then(() => Message.success(t('developerPlatform.develop.copied')));
              }}
            />
          </div>
          <Input.TextArea
            className="developer-manifest-editor"
            value={manifest ? JSON.stringify(manifest, null, 2) : ''}
            readOnly
            autoSize={{ minRows: 13, maxRows: 20 }}
            placeholder={t('developerPlatform.develop.manifestPlaceholder')}
          />
          <small className="developer-form-note">{t('developerPlatform.develop.manifestNote')}</small>
        </article>
      </div>

      <article className="surface developer-local-versions">
        <div className="developer-section-heading compact">
          <div>
            <span>{t('developerPlatform.develop.localRuntime')}</span>
            <h3>{t('developerPlatform.develop.localVersions')}</h3>
          </div>
        </div>
        {localVersions.length === 0 ? (
          <Empty description={t('developerPlatform.develop.noLocalVersion')} />
        ) : (
          localVersions.map((item) => (
            <div className="developer-local-version" key={`${item.manifest.appId}@${item.manifest.version}`}>
              <div>
                <Tag color={item.managed ? 'green' : 'orange'}>
                  {item.managed
                    ? t('developerPlatform.develop.workspaceRelease')
                    : t('developerPlatform.develop.developmentLink')}
                </Tag>
                <strong>v{item.manifest.version}</strong>
                <code>{item.installPath}</code>
              </div>
              <Button
                type="primary"
                icon={<IconPlayArrow />}
                onClick={() => void run(item.manifest.appId, item.manifest.version)}
              >
                {t('developerPlatform.develop.runVersion')}
              </Button>
            </div>
          ))
        )}
      </article>
    </div>
  );
}

function SelectApplicationEmpty() {
  const { t } = useLocale();
  return (
    <div className="surface developer-empty">
      <Empty description={t('developerPlatform.chooseApplicationFirst')} />
    </div>
  );
}
