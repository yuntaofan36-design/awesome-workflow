import { useState } from 'react';
import { Alert, Button, Input, Message, Steps, Tag } from '@arco-design/web-react';
import { IconFile, IconFolder, IconSend } from '@arco-design/web-react/icon';

import '@arco-design/web-react/es/Input/style/css.js';
import '@arco-design/web-react/es/Steps/style/css.js';
import '@arco-design/web-react/es/Tag/style/css.js';

import { desktopHost } from '@/services/desktopHost';
import { capabilityLabel, platformLabel, runtimeLabel } from '@/i18n/domain';
import { formatUiError, normalizeUiError } from '@/i18n/errors';
import { useLocale } from '@/i18n/localeContext';
import {
  selectRegisterDirectory,
  selectSnapshot,
  selectValidateDirectory,
  selectValidatedManifest,
  useDesktopStore,
} from '@/stores/desktopStore';
import type { AppletManifest } from '@/types';

export function DeveloperPage() {
  const { resolveApplicationContent, t } = useLocale();
  const [directory, setDirectory] = useState('');
  const [packagePath, setPackagePath] = useState('');
  const [sha256, setSha256] = useState('');
  const [installManifestJson, setInstallManifestJson] = useState('');
  const manifest = useDesktopStore(selectValidatedManifest);
  const localizedManifest = manifest ? resolveApplicationContent(manifest, manifest.localizations) : null;
  const installManifest = parseInstallManifest(installManifestJson);
  const validate = useDesktopStore(selectValidateDirectory);
  const register = useDesktopStore(selectRegisterDirectory);
  const snapshot = useDesktopStore(selectSnapshot);

  const chooseDirectory = async () => {
    const selected = await desktopHost.chooseDirectory(t('developer.chooseDirectoryDialog'));
    if (selected) {
      setDirectory(selected);
      await validate(selected);
    }
  };
  const choosePackage = async () => {
    const selected = await desktopHost.choosePackage(
      t('developer.choosePackageDialog'),
      t('developer.packageFilter'),
    );
    if (selected) setPackagePath(selected);
  };

  return (
    <section className="page-stack">
      <header className="page-lead">
        <div>
          <span>04</span>
          <p>{t('developer.eyebrow')}</p>
        </div>
        <h1>{t('developer.title')}</h1>
        <p>{t('developer.description')}</p>
      </header>
      {!snapshot?.developerMode && <Alert type="info" content={t('developer.productionOnly')} />}
      {snapshot?.developerMode && (
        <div className="developer-grid">
          <article className="surface developer-card">
            <div className="surface-heading">
              <div>
                <p>{t('developer.localLoop')}</p>
                <h2>{t('developer.linkTitle')}</h2>
              </div>
              <Tag color="orange">{t('developer.devOnly')}</Tag>
            </div>
            <div className="path-picker">
              <Input
                value={directory}
                onChange={setDirectory}
                placeholder={t('developer.directoryPlaceholder')}
                prefix={<IconFolder />}
              />
              <Button onClick={() => void chooseDirectory()}>{t('common.browse')}</Button>
            </div>
            {manifest ? (
              <div className="manifest-preview">
                <div>
                  <strong>{localizedManifest?.name}</strong>
                  <code>
                    {manifest.appId}@{manifest.version}
                  </code>
                </div>
                <span>
                  {manifest.runtimes
                    .map(
                      (runtime) => `${platformLabel(runtime.platform, t)}/${runtimeLabel(runtime.kind, t)}`,
                    )
                    .join(' · ')}
                </span>
                <div>
                  {manifest.capabilities.map((capability, capabilityIndex) => (
                    <Tag key={`${capability.kind}-${capabilityIndex}`}>{capabilityLabel(capability, t)}</Tag>
                  ))}
                </div>
              </div>
            ) : (
              <div className="drop-hint">{t('developer.chooseDirectoryHint')}</div>
            )}
            <Button
              type="primary"
              disabled={!manifest || !directory}
              onClick={() =>
                void register(directory).then(() => Message.success(t('developer.linkedMessage')))
              }
            >
              {t('developer.linkActivate')}
            </Button>
          </article>

          <article className="surface developer-card">
            <div className="surface-heading">
              <div>
                <p>{t('developer.localInstall')}</p>
                <h2>{t('developer.installTitle')}</h2>
              </div>
              <Tag color="green">{t('developer.failClosed')}</Tag>
            </div>
            <div className="path-picker">
              <Input
                value={packagePath}
                onChange={setPackagePath}
                placeholder={t('developer.packagePlaceholder')}
                prefix={<IconFile />}
              />
              <Button onClick={() => void choosePackage()}>{t('common.browse')}</Button>
            </div>
            <Input value={sha256} onChange={setSha256} placeholder={t('developer.digestPlaceholder')} />
            <Input.TextArea
              value={installManifestJson}
              onChange={setInstallManifestJson}
              autoSize={{ minRows: 4, maxRows: 8 }}
              placeholder={t('developer.manifestPlaceholder')}
            />
            <Button
              type="primary"
              disabled={!packagePath || sha256.length !== 64 || !installManifest}
              onClick={() =>
                installManifest &&
                void desktopHost
                  .installPackage({ packagePath, sha256, manifest: installManifest })
                  .then(() => Message.success(t('developer.installedMessage')))
                  .catch((error: unknown) =>
                    Message.error(formatUiError(normalizeUiError(error, 'package_install_failed'), t)),
                  )
              }
            >
              {t('developer.verifyInstall')}
            </Button>
          </article>
        </div>
      )}

      <article className="surface publish-card">
        <div className="surface-heading">
          <div>
            <p>{t('developer.controlPlane')}</p>
            <h2>{t('developer.publishTitle')}</h2>
          </div>
          <IconSend />
        </div>
        <Steps current={2} size="small">
          <Steps.Step
            title={t('developer.steps.package')}
            description={t('developer.steps.packageDescription')}
          />
          <Steps.Step title={t('developer.steps.sign')} description={t('developer.steps.signDescription')} />
          <Steps.Step
            title={t('developer.steps.publish')}
            description={t('developer.steps.publishDescription')}
          />
          <Steps.Step
            title={t('developer.steps.promote')}
            description={t('developer.steps.promoteDescription')}
          />
        </Steps>
        <Alert type="info" content={<>{t('developer.publishDescription')}</>} />
        <Button type="primary" disabled>
          {t('developer.uploaderPlanned')}
        </Button>
      </article>
    </section>
  );
}

function parseInstallManifest(value: string): AppletManifest | null {
  if (!value.trim()) return null;
  try {
    const manifest = JSON.parse(value) as unknown;
    return manifest && typeof manifest === 'object' ? (manifest as AppletManifest) : null;
  } catch {
    return null;
  }
}
