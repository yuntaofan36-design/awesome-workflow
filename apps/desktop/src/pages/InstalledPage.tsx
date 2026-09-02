import { Button, Empty, Message, Tag } from '@arco-design/web-react';
import { IconDelete, IconPlayArrow } from '@arco-design/web-react/icon';

import { desktopHost } from '@/services/desktopHost';
import { selectRunApplet, selectSnapshot, useDesktopStore } from '@/stores/desktopStore';
import { capabilityLabel, platformLabel } from '@/types';

export function InstalledPage() {
  const snapshot = useDesktopStore(selectSnapshot);
  const run = useDesktopStore(selectRunApplet);
  const installed = snapshot?.installed ?? [];

  return (
    <section className="page-stack">
      <PageLead
        index="02"
        eyebrow="LOCAL INVENTORY"
        title="Installed applets"
        copy="Immutable versions live under the Agent data root. Only one version is active; developer links are visibly marked and never deleted from source."
      />
      {installed.length === 0 ? (
        <div className="surface empty-surface">
          <Empty description="No applets installed" />
        </div>
      ) : (
        <div className="applet-grid">
          {installed.map((item, index) => (
            <article className="applet-card" key={`${item.manifest.appId}@${item.manifest.version}`}>
              <div className="applet-card-index">{String(index + 1).padStart(2, '0')}</div>
              <div className="applet-card-top">
                <Tag color={item.managed ? 'green' : 'orange'}>{item.managed ? 'SIGNED' : 'DEV LINK'}</Tag>
                <span>{item.manifest.runMode}</span>
              </div>
              <h3>{item.manifest.name}</h3>
              <p>{item.manifest.description || 'No description provided.'}</p>
              <div className="runtime-row">
                {item.manifest.runtimes.map((runtime) => (
                  <span key={`${platformLabel(runtime.platform)}-${runtime.kind}`}>
                    {platformLabel(runtime.platform)} / {runtime.kind}
                  </span>
                ))}
              </div>
              <div className="capability-list">
                {item.manifest.capabilities.map((capability, capabilityIndex) => (
                  <code key={`${capability.kind}-${capabilityIndex}`}>{capabilityLabel(capability)}</code>
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
                    Run
                  </Button>
                  <Button
                    status="danger"
                    type="text"
                    icon={<IconDelete />}
                    onClick={() =>
                      void desktopHost
                        .uninstallApplet(item.manifest.appId, item.manifest.version)
                        .then(() => Message.success('Version removed'))
                        .catch((error: unknown) => Message.error(String(error)))
                    }
                  />
                </div>
              </footer>
            </article>
          ))}
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
