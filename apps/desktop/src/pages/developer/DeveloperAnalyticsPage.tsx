import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Select, Spin, Table, Tag } from '@arco-design/web-react';
import { IconDashboard, IconRefresh } from '@arco-design/web-react/icon';

import { formatUiError, normalizeUiError, type UiError } from '@/i18n/errors';
import { useLocale } from '@/i18n/localeContext';
import { developerApi, type DeveloperRun } from '@/services/developerApi';
import { useDeveloperContext } from './developerContext';
import { calculateRunAnalytics, filterRunsByWindow, type AnalyticsWindow } from './analyticsModel';

const WINDOWS: AnalyticsWindow[] = ['24h', '7d', '30d', 'all'];

export function DeveloperAnalyticsPage() {
  const { selectedApplication, workspaceId } = useDeveloperContext();
  const { formatDateTime, formatNumber, t } = useLocale();
  const [window, setWindow] = useState<AnalyticsWindow>('7d');
  const [runs, setRuns] = useState<DeveloperRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<UiError | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId || !selectedApplication) return;
    setLoading(true);
    setError(null);
    try {
      setRuns(await developerApi.listRuns(workspaceId, selectedApplication.id));
    } catch (reason) {
      setError(normalizeUiError(reason, 'developer_analytics_failed'));
    } finally {
      setLoading(false);
    }
  }, [selectedApplication, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filteredRuns = useMemo(() => filterRunsByWindow(runs, window), [runs, window]);
  const analytics = useMemo(() => calculateRunAnalytics(filteredRuns), [filteredRuns]);
  const maxTrend = Math.max(1, ...analytics.trend.map((point) => point.total));
  const maxStatus = Math.max(1, ...analytics.status.map((item) => item.value));
  const maxError = Math.max(1, ...analytics.errors.map((item) => item.value));

  if (!selectedApplication) {
    return (
      <div className="surface developer-empty">
        <Empty description={t('developerPlatform.chooseApplicationFirst')} />
      </div>
    );
  }

  return (
    <div className="developer-route developer-analytics-route">
      <div className="developer-section-heading">
        <div>
          <span>{t('developerPlatform.analytics.eyebrow')}</span>
          <h2>{t('developerPlatform.analytics.title', { name: selectedApplication.name })}</h2>
          <p>{t('developerPlatform.analytics.description')}</p>
        </div>
        <div className="developer-analytics-actions">
          <Select
            aria-label={t('developerPlatform.analytics.window')}
            value={window}
            onChange={(value) => setWindow(value as AnalyticsWindow)}
            options={WINDOWS.map((value) => ({
              value,
              label: t(`developerPlatform.windows.${value}`),
            }))}
          />
          <Button icon={<IconRefresh />} loading={loading} onClick={() => void refresh()}>
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {error && <Alert type="error" content={formatUiError(error, t)} />}

      <div className="developer-metric-grid" aria-busy={loading}>
        <Metric
          index="01"
          label={t('developerPlatform.analytics.metrics.total')}
          value={formatNumber(analytics.total)}
          detail={t('developerPlatform.analytics.metrics.totalDetail')}
        />
        <Metric
          index="02"
          label={t('developerPlatform.analytics.metrics.successRate')}
          value={formatNumber(analytics.successRate, { style: 'percent', maximumFractionDigits: 1 })}
          detail={t('developerPlatform.analytics.metrics.successDetail', {
            succeeded: formatNumber(analytics.succeeded),
            failed: formatNumber(analytics.failed),
          })}
          tone={analytics.failed > 0 ? 'warning' : 'positive'}
        />
        <Metric
          index="03"
          label={t('developerPlatform.analytics.metrics.average')}
          value={formatDuration(analytics.averageDurationMs, formatNumber)}
          detail={t('developerPlatform.analytics.metrics.averageDetail')}
        />
        <Metric
          index="04"
          label={t('developerPlatform.analytics.metrics.p95')}
          value={formatDuration(analytics.p95DurationMs, formatNumber)}
          detail={t('developerPlatform.analytics.metrics.p95Detail')}
        />
      </div>

      {loading && runs.length === 0 ? (
        <div className="surface developer-route-loading">
          <Spin size={28} />
        </div>
      ) : filteredRuns.length === 0 ? (
        <div className="surface developer-empty">
          <Empty description={t('developerPlatform.analytics.empty')} />
        </div>
      ) : (
        <>
          <div className="developer-analytics-grid">
            <article className="surface developer-chart-card developer-trend-card">
              <header>
                <div>
                  <span>{t('developerPlatform.analytics.trend.eyebrow')}</span>
                  <h3>{t('developerPlatform.analytics.trend.title')}</h3>
                </div>
                <IconDashboard />
              </header>
              <div
                className="developer-trend-chart"
                role="img"
                aria-label={t('developerPlatform.analytics.trend.label')}
              >
                {analytics.trend.map((point) => (
                  <div key={point.key} className="developer-trend-column">
                    <div className="developer-trend-stack" title={`${point.key}: ${point.total}`}>
                      <i className="is-failed" style={{ height: `${(point.failed / maxTrend) * 100}%` }} />
                      <i
                        className="is-succeeded"
                        style={{ height: `${(point.succeeded / maxTrend) * 100}%` }}
                      />
                    </div>
                    <strong>{point.total}</strong>
                    <time>{formatTrendDate(point.key)}</time>
                  </div>
                ))}
              </div>
              <footer className="developer-chart-legend">
                <span>
                  <i className="is-succeeded" />
                  {t('developerPlatform.analytics.succeeded')}
                </span>
                <span>
                  <i className="is-failed" />
                  {t('developerPlatform.analytics.failed')}
                </span>
              </footer>
            </article>

            <article className="surface developer-chart-card">
              <header>
                <div>
                  <span>{t('developerPlatform.analytics.status.eyebrow')}</span>
                  <h3>{t('developerPlatform.analytics.status.title')}</h3>
                </div>
              </header>
              <div className="developer-distribution-list">
                {analytics.status.map((item) => (
                  <div key={item.key}>
                    <div>
                      <span>{t(`developerPlatform.analytics.runStatus.${item.key}`)}</span>
                      <strong>{formatNumber(item.value)}</strong>
                    </div>
                    <i>
                      <b style={{ width: `${(item.value / maxStatus) * 100}%` }} />
                    </i>
                  </div>
                ))}
              </div>
            </article>
          </div>

          <div className="developer-analytics-grid developer-analytics-lower">
            <article className="surface developer-chart-card">
              <header>
                <div>
                  <span>{t('developerPlatform.analytics.errors.eyebrow')}</span>
                  <h3>{t('developerPlatform.analytics.errors.title')}</h3>
                </div>
              </header>
              {analytics.errors.length === 0 ? (
                <div className="developer-chart-empty">{t('developerPlatform.analytics.errors.empty')}</div>
              ) : (
                <div className="developer-error-list">
                  {analytics.errors.slice(0, 6).map((item) => (
                    <div key={item.key}>
                      <code>{item.key}</code>
                      <i>
                        <b style={{ width: `${(item.value / maxError) * 100}%` }} />
                      </i>
                      <strong>{formatNumber(item.value)}</strong>
                    </div>
                  ))}
                </div>
              )}
            </article>

            <article className="surface developer-chart-card developer-trigger-card">
              <header>
                <div>
                  <span>{t('developerPlatform.analytics.trigger.eyebrow')}</span>
                  <h3>{t('developerPlatform.analytics.trigger.title')}</h3>
                </div>
              </header>
              <div className="developer-trigger-grid">
                {(['manual', 'schedule', 'api'] as const).map((trigger) => {
                  const count = filteredRuns.filter((run) => run.trigger === trigger).length;
                  return (
                    <div key={trigger}>
                      <strong>{formatNumber(count)}</strong>
                      <span>{t(`developerPlatform.analytics.trigger.${trigger}`)}</span>
                    </div>
                  );
                })}
              </div>
            </article>
          </div>

          <div className="surface table-surface developer-analytics-table">
            <Table<DeveloperRun>
              rowKey="id"
              data={[...filteredRuns].sort((left, right) => right.queuedAt.localeCompare(left.queuedAt))}
              pagination={{ pageSize: 8 }}
              columns={[
                {
                  title: t('developerPlatform.analytics.columns.run'),
                  render: (_, run) => <code>{run.id.slice(0, 8)}</code>,
                },
                {
                  title: t('developerPlatform.analytics.columns.trigger'),
                  render: (_, run) => t(`developerPlatform.analytics.trigger.${run.trigger}`),
                },
                {
                  title: t('developerPlatform.analytics.columns.status'),
                  render: (_, run) => (
                    <Tag
                      color={
                        run.status === 'failed' ? 'red' : run.status === 'succeeded' ? 'green' : 'arcoblue'
                      }
                    >
                      {t(`developerPlatform.analytics.runStatus.${run.status}`)}
                    </Tag>
                  ),
                },
                {
                  title: t('developerPlatform.analytics.columns.duration'),
                  render: (_, run) => formatDuration(runDuration(run), formatNumber),
                },
                {
                  title: t('developerPlatform.analytics.columns.queued'),
                  render: (_, run) => formatDateTime(run.queuedAt),
                },
              ]}
            />
          </div>
        </>
      )}
    </div>
  );
}

function Metric({
  index,
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  index: string;
  label: string;
  value: string;
  detail: string;
  tone?: 'neutral' | 'positive' | 'warning';
}) {
  return (
    <article className={`surface developer-metric is-${tone}`}>
      <span>
        {index} / {label}
      </span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function runDuration(run: DeveloperRun): number {
  if (!run.startedAt || !run.finishedAt) return 0;
  return Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt));
}

function formatDuration(
  durationMs: number,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
): string {
  if (durationMs < 1_000) return `${formatNumber(Math.round(durationMs))} ms`;
  if (durationMs < 60_000) {
    return `${formatNumber(durationMs / 1_000, { maximumFractionDigits: 1 })} s`;
  }
  return `${formatNumber(durationMs / 60_000, { maximumFractionDigits: 1 })} min`;
}

function formatTrendDate(value: string): string {
  const [, month, day] = value.split('-');
  return `${month}/${day}`;
}
