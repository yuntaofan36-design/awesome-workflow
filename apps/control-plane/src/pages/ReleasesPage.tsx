import { Alert, Button, Card, Skeleton, Table } from '@arco-design/web-react';
import type { ReleaseListItem } from '@awesome-workflow/contracts';
import { SectionIntro } from '@awesome-workflow/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { getReleaseStatus, listReleases } from '../api/releases';
import {
  ReleaseApplicationIdentity,
  ReleaseRuntimeTag,
  ReleaseStatusPanel,
  ReleaseStatusTag,
} from '../components/ReleaseComponents';
import { useControlPlaneI18n } from '../i18n';

export default function ReleasesPage({ workspaceId }: { workspaceId: string }) {
  const { formatDateTime, locale, t, translateError } = useControlPlaneI18n();
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);
  const releases = useQuery({
    queryKey: ['releases', workspaceId, 'web', locale.locale],
    queryFn: () => listReleases(workspaceId, { kind: 'web' }, locale.locale),
  });
  const status = useQuery({
    queryKey: ['release-status', selectedReleaseId, locale.locale],
    queryFn: () => getReleaseStatus(selectedReleaseId!, locale.locale),
    enabled: selectedReleaseId !== null,
    retry: false,
  });

  return (
    <>
      <SectionIntro
        eyebrow={t('releases.eyebrow')}
        title={
          <>
            {t('releases.titleLead')} <em>{t('releases.titleEmphasis')}</em>
          </>
        }
        description={t('releases.description')}
      />
      <Card className="cp-workflow-card" bordered={false}>
        <Alert type="info" title={t('releases.workflowTitle')} content={t('releases.workflowDescription')} />
        <ol className="cp-release-steps">
          <li>
            {t('releases.stepPackage')}{' '}
            <code>aw package --key-id &lt;key-id&gt; --private-key &lt;key.pem&gt;</code>
          </li>
          <li>
            {t('releases.stepLogin')} <code>aw login --api &lt;api-url&gt;</code>
          </li>
          <li>
            {t('releases.stepPublish')} <code>aw publish --application-id &lt;uuid&gt;</code>
          </li>
        </ol>
        <small className="cp-contract-note">{t('releases.lifecycle')}</small>
      </Card>

      <div className="cp-table-heading">
        <div>
          <span>{t('releases.historyEyebrow')}</span>
          <h3>{t('releases.historyTitle')}</h3>
        </div>
        <small>{t('releases.historyDescription')}</small>
      </div>
      {releases.isError && (
        <Alert className="cp-alert-inline" type="error" content={translateError(releases.error)} />
      )}
      <Card className="cp-table-card" bordered={false}>
        <Table
          loading={releases.isPending}
          rowKey={(row) => row.release.id}
          data={releases.data ?? []}
          pagination={{ pageSize: 10 }}
          noDataElement={<div className="cp-empty-inline">{t('releases.empty')}</div>}
          columns={[
            {
              title: t('table.application'),
              render: (_, row: ReleaseListItem) => <ReleaseApplicationIdentity item={row} />,
            },
            {
              title: t('table.version'),
              render: (_, row: ReleaseListItem) => <code>{row.release.version}</code>,
            },
            {
              title: t('table.status'),
              render: (_, row: ReleaseListItem) => <ReleaseStatusTag status={row.release.status} />,
            },
            {
              title: t('table.runtime'),
              render: (_, row: ReleaseListItem) => <ReleaseRuntimeTag item={row} />,
            },
            { title: t('table.artifacts'), dataIndex: 'artifactCount' },
            {
              title: t('table.created'),
              render: (_, row: ReleaseListItem) => formatDateTime(row.release.createdAt),
            },
            {
              title: '',
              render: (_, row: ReleaseListItem) => (
                <Button size="small" onClick={() => setSelectedReleaseId(row.release.id)}>
                  {t('releases.inspectEvidence')}
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {status.isFetching && <Skeleton className="cp-inspector" animation text={{ rows: 4 }} />}
      {status.isError && (
        <Alert className="cp-alert-inline" type="error" content={translateError(status.error)} />
      )}
      {status.data && <ReleaseStatusPanel view={status.data} />}
    </>
  );
}
