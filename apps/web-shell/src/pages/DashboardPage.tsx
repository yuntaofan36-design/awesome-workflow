import { Alert, Button, Card, Progress, Skeleton } from '@arco-design/web-react';
import { IconArrowRight, IconCheckCircle, IconLaunch } from '@arco-design/web-react/icon';
import { MetricCard, SectionIntro, SignalBadge, StatePanel } from '@awesome-workflow/ui';
import { Link, useOutletContext } from 'react-router-dom';

import type { ShellOutletContext } from '../components/ShellLayout';

export function DashboardPage() {
  const { catalog, catalogError, catalogPending, refreshCatalog } = useOutletContext<ShellOutletContext>();
  const federationCount = catalog.filter((entry) => entry.manifest.runtime === 'federation').length;
  const isolatedCount = catalog.filter((entry) => entry.manifest.runtime === 'iframe').length;

  return (
    <main className="shell-page dashboard-page">
      <SectionIntro
        eyebrow="Workspace / Runtime topology"
        title={
          <>
            Ship web and desktop tools as <em>governed micro-apps.</em>
          </>
        }
        description="The host owns identity, navigation and policy. Each application declares how it executes, what it can request, and which immutable release is active."
        action={
          <Button icon={<IconLaunch />} onClick={() => void refreshCatalog()}>
            Refresh catalog
          </Button>
        }
      />

      {catalogError && (
        <Alert
          className="page-alert"
          type="error"
          title="Catalog unavailable"
          content={catalogError.message}
        />
      )}
      <section className="dashboard-metrics">
        <MetricCard label="active apps" value={catalog.length} detail="stable channel / current workspace" />
        <MetricCard label="trusted remotes" value={federationCount} detail="Module Federation 2 manifests" />
        <MetricCard label="isolated frames" value={isolatedCount} detail="separate-origin MessageChannels" />
        <MetricCard label="host api" value="v1" detail="capability-scoped, credential-free" />
      </section>

      <section className="dashboard-grid">
        <div className="dashboard-apps">
          <div className="section-row">
            <div>
              <span>CATALOG / STABLE</span>
              <h2>Runnable applications</h2>
            </div>
            <SignalBadge tone="success">immutable releases</SignalBadge>
          </div>
          {catalogPending ? (
            <Skeleton animation text={{ rows: 6 }} />
          ) : catalog.length === 0 ? (
            <StatePanel title="No application is promoted">
              <p>Publish a release and promote it to stable from the Control Plane.</p>
            </StatePanel>
          ) : (
            <div className="app-card-grid">
              {catalog.map((entry, index) => (
                <Link className="app-card" key={entry.applicationId} to={`/apps/${entry.slug}`}>
                  <div className="app-card__index">{String(index + 1).padStart(2, '0')}</div>
                  <div className="app-card__body">
                    <div>
                      <RuntimeBadge runtime={entry.manifest.runtime} />
                      <code>{entry.version}</code>
                    </div>
                    <h3>{entry.name}</h3>
                    <p>{entry.summary}</p>
                  </div>
                  <IconArrowRight className="app-card__arrow" />
                </Link>
              ))}
            </div>
          )}
        </div>

        <Card className="governance-card" bordered={false}>
          <span>DELIVERY MODEL</span>
          <h2>
            Release once.
            <br />
            Promote intent.
          </h2>
          <div className="governance-track">
            {['dev', 'canary', 'stable'].map((channel, index) => (
              <div key={channel}>
                <i>{index === 2 ? <IconCheckCircle /> : index + 1}</i>
                <span>{channel}</span>
              </div>
            ))}
          </div>
          <Progress percent={100} showText={false} color="#c8f04a" trailColor="var(--aw-line)" />
          <p>
            The artifact identity remains constant across channels. Approvals move a release pointer; they
            never rebuild code.
          </p>
          <Button type="text" href="/apps/control-plane">
            Open Control Plane <IconArrowRight />
          </Button>
        </Card>
      </section>
    </main>
  );
}

function RuntimeBadge({ runtime }: { runtime: 'federation' | 'iframe' | 'link' }) {
  return <SignalBadge tone={runtime === 'federation' ? 'success' : 'neutral'}>{runtime}</SignalBadge>;
}
