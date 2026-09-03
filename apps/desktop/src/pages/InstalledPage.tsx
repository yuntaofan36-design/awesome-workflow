import { Button, Empty, Message, Tag } from '@arco-design/web-react';
import { IconDelete, IconPlayArrow } from '@arco-design/web-react/icon';

import { desktopHost } from '@/services/desktopHost';
import { capabilityLabel, platformLabel, runModeLabel, runtimeLabel } from '@/i18n/domain';
import { formatUiError, normalizeUiError } from '@/i18n/errors';
import { useLocale } from '@/i18n/localeContext';
import { selectRunApplet, selectSnapshot, useDesktopStore } from '@/stores/desktopStore';

export function InstalledPage() {
  const { resolveApplicationContent, t } = useLocale();
  const snapshot = useDesktopStore(selectSnapshot);
  const run = useDesktopStore(selectRunApplet);
  const installed = snapshot?.installed ?? [];

  return (
    <section className="page-stack">
      <PageLead
        index="02"
        eyebrow={t('installed.eyebrow')}
        title={t('installed.title')}
        copy={t('installed.description')}
      />
      {installed.length === 0 ? (
        <div className="surface empty-surface">
          <Empty description={t('installed.empty')} />
        </div>
      ) : (
        <div className="applet-grid">
          {installed.map((item, index) => {
            const content = resolveApplicationContent(item.manifest, item.manifest.localizations);
            return (
              <article className="applet-card" key={`${item.manifest.appId}@${item.manifest.version}`}>
                <div className="applet-card-index">{String(index + 1).padStart(2, '0')}</div>
                <div className="applet-card-top">
                  <Tag color={item.managed ? 'green' : 'orange'}>
                    {item.managed ? t('installed.signed') : t('installed.devLink')}
                  </Tag>
                  <span>{runModeLabel(item.manifest.runMode, t)}</span>
                </div>
                <h3>{content.name}</h3>
                <p>{content.description || t('installed.noDescription')}</p>
                <div className="runtime-row">
                  {item.manifest.runtimes.map((runtime) => (
                    <span key={`${runtime.platform.os}-${runtime.platform.arch}-${runtime.kind}`}>
                      {platformLabel(runtime.platform, t)} / {runtimeLabel(runtime.kind, t)}
                    </span>
                  ))}
                </div>
                <div className="capability-list">
                  {item.manifest.capabilities.map((capability, capabilityIndex) => (
                    <code key={`${capability.kind}-${capabilityIndex}`}>
                      {capabilityLabel(capability, t)}
                    </code>
                  ))}
                </div>
                <footer>
                  <strong>v{item.manifest.version}</strong>
                  <div>
                    <Button
                      icon={<IconPlayArrow />}
                      type="primary"
                      onClick={() => void run(item.manifest.appId, item.manifest.version)}
                    >
                      {t('common.run')}
                    </Button>
                    <Button
                      status="danger"
                      type="text"
                      icon={<IconDelete />}
                      aria-label={t('installed.uninstallAria', {
                        name: content.name,
                        version: item.manifest.version,
                      })}
                      onClick={() =>
                        void desktopHost
                          .uninstallApplet(item.manifest.appId, item.manifest.version)
                          .then(() => Message.success(t('installed.removedMessage')))
                          .catch((error: unknown) =>
                            Message.error(
                              formatUiError(normalizeUiError(error, 'applet_uninstall_failed'), t),
                            ),
                          )
                      }
                    />
                  </div>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PageLead({
  index,
  eyebrow,
  title,
  copy,
}: {
  index: string;
  eyebrow: string;
  title: string;
  copy: string;
}) {
  return (
    <header className="page-lead">
      <div>
        <span>{index}</span>
        <p>{eyebrow}</p>
      </div>
      <h1>{title}</h1>
      <p>{copy}</p>
    </header>
  );
}
