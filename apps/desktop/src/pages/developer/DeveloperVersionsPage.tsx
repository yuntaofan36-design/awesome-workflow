import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Drawer, Empty, Message, Spin, Table, Tag } from '@arco-design/web-react';
import { IconEye, IconHistory, IconToRight } from '@arco-design/web-react/icon';

import { formatUiError, normalizeUiError, type UiError } from '@/i18n/errors';
import { useLocale } from '@/i18n/localeContext';
import {
  developerApi,
  type DeveloperCatalogEntry,
  type DeveloperReleaseListItem,
  type DeveloperReleaseStatus,
} from '@/services/developerApi';
import { useDeveloperContext } from './developerContext';

const CHANNELS: DeveloperCatalogEntry['channel'][] = ['dev', 'canary', 'stable'];

export function DeveloperVersionsPage() {
  const { selectedApplication, workspaceId } = useDeveloperContext();
  const { formatBytes, formatDateTime, t } = useLocale();
  const [releases, setReleases] = useState<DeveloperReleaseListItem[]>([]);
  const [catalog, setCatalog] = useState<DeveloperCatalogEntry[]>([]);
  const [detail, setDetail] = useState<DeveloperReleaseStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [promoting, setPromoting] = useState('');
  const [error, setError] = useState<UiError | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId || !selectedApplication) return;
    setLoading(true);
    setError(null);
    try {
      const [releaseValues, ...channelValues] = await Promise.all([
        developerApi.listReleases(workspaceId, selectedApplication.id),
        ...CHANNELS.map((channel) => developerApi.listCatalog(workspaceId, channel)),
      ]);
      setReleases(releaseValues);
      setCatalog(channelValues.flat());
    } catch (reason) {
      setError(normalizeUiError(reason, 'developer_versions_failed'));
    } finally {
      setLoading(false);
    }
  }, [selectedApplication, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const channelsByRelease = useMemo(() => {
    const values = new Map<string, DeveloperCatalogEntry['channel'][]>();
    for (const entry of catalog) {
      values.set(entry.releaseId, [...(values.get(entry.releaseId) ?? []), entry.channel]);
    }
    return values;
  }, [catalog]);

  if (!selectedApplication) {
    return (
      <div className="surface developer-empty">
        <Empty description={t('developerPlatform.chooseApplicationFirst')} />
      </div>
    );
  }

  const promote = async (release: DeveloperReleaseListItem, channel: DeveloperCatalogEntry['channel']) => {
    const key = `${release.release.id}:${channel}`;
    setPromoting(key);
    try {
      const current = catalog.find(
        (entry) => entry.applicationId === selectedApplication.id && entry.channel === channel,
      );
      await developerApi.promote({
        applicationId: selectedApplication.id,
        releaseId: release.release.id,
        channel,
        expectedCurrentReleaseId: current?.releaseId ?? null,
      });
      await refresh();
      Message.success(t('developerPlatform.versions.promoted', { channel }));
    } catch (reason) {
      Message.error(formatUiError(normalizeUiError(reason, 'release_promote_failed'), t));
    } finally {
      setPromoting('');
    }
  };

  return (
    <div className="developer-route">
      <div className="developer-section-heading">
        <div>
          <span>{t('developerPlatform.versions.eyebrow')}</span>
          <h2>{t('developerPlatform.versions.title', { name: selectedApplication.name })}</h2>
          <p>{t('developerPlatform.versions.description')}</p>
        </div>
        <Button icon={<IconHistory />} loading={loading} onClick={() => void refresh()}>
          {t('common.refresh')}
        </Button>
      </div>

      <div className="developer-channel-rail">
        {CHANNELS.map((channel) => {
          const current = catalog.find(
            (entry) => entry.applicationId === selectedApplication.id && entry.channel === channel,
          );
          return (
            <div key={channel}>
              <span>{channel.toUpperCase()}</span>
              <strong>{current ? `v${current.version}` : '—'}</strong>
              <small>
                {current ? current.releaseId.slice(0, 8) : t('developerPlatform.versions.unassigned')}
              </small>
            </div>
          );
        })}
      </div>

      {error && <Alert type="error" content={formatUiError(error, t)} />}
      <div className="surface table-surface developer-version-table">
        <Table<DeveloperReleaseListItem>
          rowKey={(row) => row.release.id}
          data={releases}
          loading={loading}
          pagination={{ pageSize: 8 }}
          noDataElement={<Empty description={t('developerPlatform.versions.empty')} />}
          columns={[
            {
              title: t('developerPlatform.versions.columns.version'),
              render: (_, row) => <strong>v{row.release.version}</strong>,
            },
            {
              title: t('developerPlatform.versions.columns.status'),
              render: (_, row) => (
                <Tag color={statusColor(row.release.status)}>{row.release.status.toUpperCase()}</Tag>
              ),
            },
            {
              title: t('developerPlatform.versions.columns.channel'),
              render: (_, row) => (
                <div className="developer-chip-row">
                  {(channelsByRelease.get(row.release.id) ?? []).map((channel) => (
                    <Tag key={channel}>{channel}</Tag>
                  ))}
                  {!channelsByRelease.has(row.release.id) && <span>—</span>}
                </div>
              ),
            },
            { title: t('developerPlatform.versions.columns.artifacts'), dataIndex: 'artifactCount' },
            {
              title: t('developerPlatform.versions.columns.created'),
              render: (_, row) => formatDateTime(row.release.createdAt),
            },
            {
              title: '',
              render: (_, row) => (
                <div className="row-actions developer-version-actions">
                  <Button
                    type="text"
                    icon={<IconEye />}
                    onClick={() => {
                      setDetail(null);
                      void developerApi
                        .releaseStatus(row.release.id)
                        .then(setDetail)
                        .catch((reason: unknown) =>
                          Message.error(formatUiError(normalizeUiError(reason, 'release_status_failed'), t)),
                        );
                    }}
                  >
                    {t('developerPlatform.versions.inspect')}
                  </Button>
                  {row.release.status === 'approved' &&
                    CHANNELS.map((channel) => (
                      <Button
                        key={channel}
                        size="mini"
                        icon={<IconToRight />}
                        loading={promoting === `${row.release.id}:${channel}`}
                        disabled={(channelsByRelease.get(row.release.id) ?? []).includes(channel)}
                        onClick={() => void promote(row, channel)}
                      >
                        {channel}
                      </Button>
                    ))}
                </div>
              ),
            },
          ]}
        />
      </div>

      <Drawer
        width={720}
        visible={Boolean(detail)}
        title={detail ? `${selectedApplication.name} · v${detail.release.version}` : ''}
        footer={null}
        onCancel={() => setDetail(null)}
      >
        {!detail ? (
          <Spin />
        ) : (
          <div className="developer-release-detail">
            <div className="developer-release-facts">
              <span>{detail.release.status.toUpperCase()}</span>
              <code>{detail.release.id}</code>
              <time>{formatDateTime(detail.release.createdAt)}</time>
            </div>
            <h3>{t('developerPlatform.versions.artifacts')}</h3>
            {detail.artifacts.map((artifact) => (
              <article key={artifact.id}>
                <div>
                  <strong>{artifact.fileName}</strong>
                  <Tag>{artifact.status}</Tag>
                </div>
                <small>{formatBytes(artifact.size)}</small>
                <code>{artifact.sha256}</code>
              </article>
            ))}
            <h3>{t('developerPlatform.versions.reviews')}</h3>
            {detail.reviews.length === 0 ? (
              <Empty description={t('developerPlatform.versions.noReviews')} />
            ) : (
              detail.reviews.map((review) => (
                <article key={review.id}>
                  <div>
                    <strong>{review.decision.toUpperCase()}</strong>
                    <time>{formatDateTime(review.createdAt)}</time>
                  </div>
                  <p>{review.comment || t('developerPlatform.versions.noComment')}</p>
                </article>
              ))
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}

function statusColor(status: DeveloperReleaseListItem['release']['status']) {
  if (status === 'approved' || status === 'ready') return 'green';
  if (status === 'rejected') return 'red';
  if (status === 'validating') return 'arcoblue';
  return 'orange';
}
