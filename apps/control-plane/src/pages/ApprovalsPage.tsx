import { Alert, Button, Card, Input, Popconfirm, Skeleton, Space, Table } from '@arco-design/web-react';
import { IconCheckCircle } from '@arco-design/web-react/icon';
import type { ReleaseListItem } from '@awesome-workflow/contracts';
import { SectionIntro } from '@awesome-workflow/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { getReleaseStatus, listPendingReviews, reviewRelease } from '../api/releases';
import {
  ReleaseApplicationIdentity,
  ReleaseStatusPanel,
  ReleaseStatusTag,
} from '../components/ReleaseComponents';
import type { Identity, Notify } from '../controlPlaneTypes';
import { useControlPlaneI18n } from '../i18n';
import '../styles/arco-approvals.less';
import '../styles/arco-form-controls.less';

export default function ApprovalsPage({ identity, notify }: { identity: Identity; notify: Notify }) {
  const { formatDateTime, formatNumber, locale, t, translateError } = useControlPlaneI18n();
  const queryClient = useQueryClient();
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const queue = useQuery({
    queryKey: ['review-queue', identity.workspace.id, 'web', locale.locale],
    queryFn: () => listPendingReviews(identity.workspace.id, 'web', locale.locale),
  });
  const status = useQuery({
    queryKey: ['release-status', selectedReleaseId, locale.locale],
    queryFn: () => getReleaseStatus(selectedReleaseId!, locale.locale),
    enabled: selectedReleaseId !== null,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => {
      if (!selectedReleaseId) throw new Error(t('approvals.selectPending'));
      return reviewRelease({ comment, decision, releaseId: selectedReleaseId, locale: locale.locale });
    },
    onSuccess: async (view, decision) => {
      queryClient.setQueryData(['release-status', view.release.id, locale.locale], view);
      notify(decision === 'approve' ? t('approvals.approvalRecorded') : t('approvals.rejectionRecorded'));
      setComment('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['review-queue', identity.workspace.id] }),
        queryClient.invalidateQueries({ queryKey: ['releases', identity.workspace.id] }),
      ]);
    },
  });
  const canReview =
    identity.user.platformRoles.includes('platform_admin') ||
    identity.user.platformRoles.includes('official_reviewer');
  const release = status.data?.release;
  const isReady = release?.status === 'ready';

  return (
    <>
      <SectionIntro
        eyebrow={t('approvals.eyebrow')}
        title={
          <>
            {t('approvals.titleLead')} <em>{t('approvals.titleEmphasis')}</em>
          </>
        }
        description={t('approvals.description')}
      />
      {!canReview && (
        <Alert className="cp-alert-inline" type="warning" content={t('approvals.insufficientAuthority')} />
      )}
      {queue.isError && (
        <Alert className="cp-alert-inline" type="error" content={translateError(queue.error)} />
      )}
      <Card className="cp-table-card" bordered={false}>
        <Table
          loading={queue.isPending}
          rowKey={(row) => row.release.id}
          data={queue.data ?? []}
          pagination={{ pageSize: 10 }}
          noDataElement={
            <div className="cp-empty-queue">
              <IconCheckCircle />
              {t('approvals.empty')}
            </div>
          }
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
              title: t('table.evidence'),
              render: (_, row: ReleaseListItem) => formatNumber(row.release.validationEvidence.length),
            },
            {
              title: t('table.artifacts'),
              dataIndex: 'artifactCount',
              render: (value: number) => formatNumber(value),
            },
            {
              title: t('table.created'),
              render: (_, row: ReleaseListItem) => formatDateTime(row.release.createdAt),
            },
            {
              title: '',
              render: (_, row: ReleaseListItem) => (
                <Button size="small" onClick={() => setSelectedReleaseId(row.release.id)}>
                  {t('approvals.reviewEvidence')}
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
      {status.data && (
        <section className="cp-inspector">
          <>
            <ReleaseStatusPanel view={status.data} />
            <Card className="cp-review-card" bordered={false}>
              <header>
                <div>
                  <span>{t('approvals.decisionEyebrow')}</span>
                  <h3>
                    {isReady
                      ? t('approvals.decisionRequired')
                      : t('approvals.releaseState', {
                          status: release ? t(`enums.releaseStatus.${release.status}`) : '—',
                        })}
                  </h3>
                </div>
                {release && <ReleaseStatusTag status={release.status} />}
              </header>
              {!isReady && <Alert type="warning" content={t('approvals.notReady')} />}
              {mutation.isError && <Alert type="error" content={translateError(mutation.error)} />}
              <Input.TextArea
                disabled={!canReview || !isReady}
                maxLength={1000}
                onChange={setComment}
                placeholder={t('approvals.commentPlaceholder')}
                showWordLimit
                value={comment}
              />
              <Space className="cp-review-actions">
                <Popconfirm
                  disabled={!canReview || !isReady}
                  title={t('approvals.approveConfirm', { version: release?.version ?? '' })}
                  onOk={() => mutation.mutate('approve')}
                >
                  <Button
                    type="primary"
                    disabled={!canReview || !isReady}
                    loading={mutation.isPending}
                    icon={<IconCheckCircle />}
                  >
                    {t('approvals.recordApproval')}
                  </Button>
                </Popconfirm>
                <Popconfirm
                  disabled={!canReview || !isReady}
                  title={t('approvals.rejectConfirm', { version: release?.version ?? '' })}
                  onOk={() => mutation.mutate('reject')}
                >
                  <Button status="danger" disabled={!canReview || !isReady} loading={mutation.isPending}>
                    {t('approvals.recordRejection')}
                  </Button>
                </Popconfirm>
              </Space>
              <small className="cp-contract-note">{t('approvals.promotionNote')}</small>
            </Card>
          </>
        </section>
      )}
    </>
  );
}
