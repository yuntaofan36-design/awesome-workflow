import { Button, Card, Progress, Skeleton } from '@arco-design/web-react';
import { IconArrowRight, IconCheckCircle, IconLaunch } from '@arco-design/web-react/icon';
import { MetricCard, SectionIntro, SignalBadge, StatePanel } from '@awesome-workflow/ui';
import { formatNumber } from '@awesome-workflow/i18n';
import { Link, useOutletContext } from 'react-router-dom';

import '@arco-design/web-react/es/Card/style/css.js';
import '@arco-design/web-react/es/Progress/style/css.js';
import '@arco-design/web-react/es/Skeleton/style/css.js';

import type { ShellOutletContext } from '../components/ShellLayout';
import { LocalizedErrorAlert } from '../components/LocalizedErrorAlert';
import { useI18n } from '../i18n/I18nProvider';
import { selectLocaleSnapshot, useShellStore } from '../stores/shellStore';

export function DashboardPage() {
  const { t } = useI18n();
  const locale = useShellStore(selectLocaleSnapshot);
  const { catalog, catalogError, catalogPending, refreshCatalog } = useOutletContext<ShellOutletContext>();
  const federationCount = catalog.filter((entry) => entry.manifest.runtime === 'federation').length;
  const isolatedCount = catalog.filter((entry) => entry.manifest.runtime === 'iframe').length;

  return (
    <main className="shell-page dashboard-page">
      <SectionIntro
        eyebrow={t('dashboard.eyebrow')}
        title={
          <>
            {t('dashboard.title')} <em>{t('dashboard.titleEmphasis')}</em>
          </>
        }
        description={t('dashboard.description')}
        action={
          <Button icon={<IconLaunch />} onClick={() => void refreshCatalog()}>
            {t('common.refreshCatalog')}
          </Button>
        }
      />

      {catalogError && (
        <LocalizedErrorAlert
          className="page-alert"
          title={t('runtime.catalogUnavailable')}
          error={catalogError}
        />
      )}
      <section className="dashboard-metrics">
        <MetricCard
          label={t('dashboard.activeApps')}
          value={formatNumber(catalog.length, locale)}
          detail={t('dashboard.activeAppsDetail')}
        />
        <MetricCard
          label={t('dashboard.trustedRemotes')}
          value={formatNumber(federationCount, locale)}
          detail={t('dashboard.trustedRemotesDetail')}
        />
        <MetricCard
          label={t('dashboard.isolatedFrames')}
          value={formatNumber(isolatedCount, locale)}
          detail={t('dashboard.isolatedFramesDetail')}
        />
        <MetricCard label={t('dashboard.hostApi')} value="v1" detail={t('dashboard.hostApiDetail')} />
      </section>

      <section className="dashboard-grid">
        <div className="dashboard-apps">
          <div className="section-row">
            <div>
              <span>{t('dashboard.catalogStable')}</span>
              <h2>{t('dashboard.runnableApplications')}</h2>
            </div>
            <SignalBadge tone="success">{t('dashboard.immutableReleases')}</SignalBadge>
          </div>
          {catalogPending ? (
            <Skeleton animation text={{ rows: 6 }} />
          ) : catalog.length === 0 ? (
            <StatePanel title={t('dashboard.noAppsTitle')}>
              <p>{t('dashboard.noAppsBody')}</p>
            </StatePanel>
          ) : (
            <div className="app-card-grid">
              {catalog.map((entry, index) => (
                <Link className="app-card" key={entry.applicationId} to={`/apps/${entry.slug}`}>
                  <div className="app-card__index">{String(index + 1).padStart(2, '0')}</div>
                  <div className="app-card__body">
                    <div>
                      <RuntimeBadge
                        runtime={entry.manifest.runtime}
                        label={t(`runtimeLabel.${entry.manifest.runtime}`)}
                      />
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
          <span>{t('dashboard.deliveryModel')}</span>
          <h2>
            {t('dashboard.deliveryRelease')}
            <br />
            {t('dashboard.deliveryPromote')}
          </h2>
          <div className="governance-track">
            {['dev', 'canary', 'stable'].map((channel, index) => (
              <div key={channel}>
                <i>{index === 2 ? <IconCheckCircle /> : index + 1}</i>
                <span>{t(`channel.${channel}`)}</span>
              </div>
            ))}
          </div>
          <Progress percent={100} showText={false} color="#c8f04a" trailColor="var(--aw-line)" />
          <p>{t('dashboard.deliveryBody')}</p>
          <Button type="text" href="/apps/control-plane">
            {t('dashboard.openControlPlane')} <IconArrowRight />
          </Button>
        </Card>
      </section>
    </main>
  );
}

function RuntimeBadge({ label, runtime }: { label: string; runtime: 'federation' | 'iframe' | 'link' }) {
  return <SignalBadge tone={runtime === 'federation' ? 'success' : 'neutral'}>{label}</SignalBadge>;
}
