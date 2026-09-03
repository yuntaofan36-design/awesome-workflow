import { Card, Table, Tag } from '@arco-design/web-react';
import type { ReleaseListItem, ReleaseStatus, ReleaseStatusView } from '@awesome-workflow/contracts';

import type { WebManifest } from '../domain';
import { useControlPlaneI18n } from '../i18n';
import '../styles/arco-data.less';

export function ReleaseStatusPanel({ view }: { view: ReleaseStatusView }) {
  const { formatBytes, formatDateTime, formatNumber, t } = useControlPlaneI18n();
  return (
    <Card className="cp-release-status" bordered={false}>
      <header>
        <div>
          <span>{t('releasePanel.eyebrow')}</span>
          <h3>{view.release.version}</h3>
          <code>{view.release.id}</code>
        </div>
        <ReleaseStatusTag status={view.release.status} />
      </header>
      <div className="cp-release-facts">
        <div>
          <span>{t('releasePanel.application')}</span>
          <code>{view.release.applicationId}</code>
        </div>
        <div>
          <span>{t('releasePanel.manifest')}</span>
          <strong>{t(`enums.applicationKind.${view.release.manifest.kind}`)}</strong>
        </div>
        <div>
          <span>{t('releasePanel.artifacts')}</span>
          <strong>{formatNumber(view.artifacts.length)}</strong>
        </div>
        <div>
          <span>{t('releasePanel.reviews')}</span>
          <strong>{formatNumber(view.reviews.length)}</strong>
        </div>
      </div>
      <Table
        border={{ cell: true }}
        data={view.artifacts}
        pagination={false}
        rowKey="id"
        noDataElement={<div className="cp-empty-inline">{t('releasePanel.emptyArtifacts')}</div>}
        columns={[
          { title: t('table.artifact'), dataIndex: 'fileName' },
          { title: t('table.size'), dataIndex: 'size', render: (size: number) => formatBytes(size) },
          {
            title: t('table.status'),
            dataIndex: 'status',
            render: (status: string) => <Tag bordered>{t(`enums.artifactStatus.${status}`)}</Tag>,
          },
          {
            title: t('table.finalized'),
            dataIndex: 'finalizedAt',
            render: (value?: string) => (value ? formatDateTime(value) : '—'),
          },
        ]}
      />
      {view.reviews.length > 0 && (
        <Table
          className="cp-review-history"
          border={{ cell: true }}
          data={view.reviews}
          pagination={false}
          rowKey="id"
          columns={[
            {
              title: t('table.decision'),
              dataIndex: 'decision',
              render: (decision: string) => (
                <Tag color={decision === 'approve' ? 'green' : 'red'}>
                  {t(`enums.reviewDecision.${decision}`)}
                </Tag>
              ),
            },
            { title: t('table.comment'), dataIndex: 'comment', render: (value: string) => value || '—' },
            {
              title: t('table.recorded'),
              dataIndex: 'createdAt',
              render: (value: string) => formatDateTime(value),
            },
          ]}
        />
      )}
    </Card>
  );
}

export function ReleaseStatusTag({ status }: { status: ReleaseStatus }) {
  const { t } = useControlPlaneI18n();
  const color =
    status === 'approved' ? 'green' : status === 'rejected' ? 'red' : status === 'ready' ? 'orange' : 'gray';
  return (
    <Tag bordered color={color}>
      {t(`enums.releaseStatus.${status}`)}
    </Tag>
  );
}

export function ReleaseApplicationIdentity({ item }: { item: ReleaseListItem }) {
  const { localizeContent } = useControlPlaneI18n();
  const content = localizeContent(
    item.application,
    item.application.localizations,
    item.application.defaultLocale,
  );
  return (
    <div className="cp-app-id">
      <strong>{content.name}</strong>
      <small className="cp-app-id__summary">{content.summary}</small>
      <span className="cp-block-id">{item.application.slug}</span>
    </div>
  );
}

export function ReleaseRuntimeTag({ item }: { item: ReleaseListItem }) {
  const { t } = useControlPlaneI18n();
  if (item.release.manifest.kind !== 'web') return <Tag bordered>{t('enums.applicationKind.desktop')}</Tag>;
  return <RuntimeTag runtime={item.release.manifest.runtime} />;
}

function RuntimeTag({ runtime }: { runtime: WebManifest['runtime'] }) {
  const { t } = useControlPlaneI18n();
  return (
    <Tag bordered color={runtime === 'federation' ? 'lime' : runtime === 'iframe' ? 'arcoblue' : 'gray'}>
      {t(`enums.runtime.${runtime}`)}
    </Tag>
  );
}
