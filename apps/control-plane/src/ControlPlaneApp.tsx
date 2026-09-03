import {
  Alert,
  Avatar,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
} from '@arco-design/web-react';
import {
  IconApps,
  IconBranch,
  IconCheckCircle,
  IconExperiment,
  IconPlus,
  IconRefresh,
} from '@arco-design/web-react/icon';
import type {
  Application,
  ApplicationLocalizations,
  LocalePreference,
  ReleaseListItem,
  ReleaseStatus,
  ReleaseStatusView,
  SupportedLocale,
} from '@awesome-workflow/contracts';
import { MetricCard, SectionIntro, SignalBadge } from '@awesome-workflow/ui';
import type { HostApi, ThemeSnapshot, UserSummary, WorkspaceSummary } from '@awesome-workflow/web-sdk';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { MemoryRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';

import {
  createWebApplication,
  getReleaseStatus,
  listApplications,
  listCatalog,
  listPendingReviews,
  listReleases,
  reviewRelease,
} from './api';
import type { CatalogEntry, ReleaseChannel, WebManifest } from './domain';
import { useControlPlaneI18n } from './i18n';

const CHANNELS = ['dev', 'canary', 'stable'] as const;

type Identity = { theme: ThemeSnapshot; user: UserSummary; workspace: WorkspaceSummary };
type CatalogMatrix = Record<ReleaseChannel, CatalogEntry[]>;

export function ControlPlaneApp({ host, initialPath }: { host: HostApi; initialPath: string }) {
  const { t, translateError } = useControlPlaneI18n();
  const identity = useQuery({
    queryKey: ['host', 'identity'],
    queryFn: async (): Promise<Identity> => {
      const [theme, user, workspace] = await Promise.all([
        host.theme.getCurrent(),
        host.user.getSummary(),
        host.workspace.getCurrent(),
      ]);
      return { theme, user, workspace };
    },
    staleTime: Infinity,
  });
  const [themeOverride, setThemeOverride] = useState<ThemeSnapshot | null>(null);

  useEffect(() => host.events.on('theme.changed', setThemeOverride), [host]);

  if (identity.isPending) {
    return <ControlPlaneBoot />;
  }
  if (identity.isError) {
    return (
      <div className="cp-fatal">
        <Alert
          type="error"
          title={t('errors.hostContextUnavailable')}
          content={translateError(identity.error)}
        />
      </div>
    );
  }

  const resolvedIdentity = { ...identity.data, theme: themeOverride ?? identity.data.theme };
  return (
    <div className="cp-root" data-aw-theme={resolvedIdentity.theme.resolved}>
      <MemoryRouter initialEntries={[initialPath]}>
        <ControlPlaneFrame host={host} identity={resolvedIdentity} />
      </MemoryRouter>
    </div>
  );
}

function ControlPlaneBoot() {
  const { t } = useControlPlaneI18n();
  return (
    <div className="cp-boot">
      <span>{t('app.handshake')}</span>
      <Skeleton animation text={{ rows: 4, width: ['36%', '72%', '58%', '44%'] }} />
    </div>
  );
}

function ControlPlaneFrame({ host, identity }: { host: HostApi; identity: Identity }) {
  const { locale, standaloneLocale, t, translateError } = useControlPlaneI18n();
  const location = useLocation();
  const queries = useQueries({
    queries: CHANNELS.map((channel) => ({
      queryKey: ['catalog', identity.workspace.id, channel, locale.locale],
      queryFn: () => listCatalog(identity.workspace.id, channel, locale.locale),
    })),
  });
  const queryClient = useQueryClient();
  const matrix = CHANNELS.reduce<CatalogMatrix>(
    (result, channel, index) => {
      result[channel] = queries[index]?.data ?? [];
      return result;
    },
    { canary: [], dev: [], stable: [] },
  );
  const isPending = queries.some((query) => query.isPending);
  const error = queries.find((query) => query.error)?.error;
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['applications', identity.workspace.id] }),
      queryClient.invalidateQueries({ queryKey: ['catalog', identity.workspace.id] }),
      queryClient.invalidateQueries({ queryKey: ['releases', identity.workspace.id] }),
      queryClient.invalidateQueries({ queryKey: ['review-queue', identity.workspace.id] }),
    ]);
  };
  const notify = (message: string) =>
    void host.broker.request({ operation: 'notifications.show', payload: { level: 'success', message } });

  useEffect(() => {
    void host.navigation.navigate(`/apps/control-plane${location.pathname}`, { replace: true });
  }, [host, location.pathname]);

  return (
    <div className="cp-frame">
      <aside className="cp-rail">
        <div className="cp-rail__label">{t('navigation.operate')}</div>
        <ControlNavLink icon={<IconApps />} label={t('navigation.applications')} to="/applications" />
        <ControlNavLink icon={<IconBranch />} label={t('navigation.releases')} to="/releases" />
        <ControlNavLink icon={<IconExperiment />} label={t('navigation.channels')} to="/channels" />
        <ControlNavLink icon={<IconCheckCircle />} label={t('navigation.approvals')} to="/approvals" />
        <div className="cp-rail__footer">
          <SignalBadge tone={error ? 'danger' : isPending ? 'warning' : 'success'}>
            {error ? t('sync.fault') : isPending ? t('sync.syncing') : t('sync.live')}
          </SignalBadge>
        </div>
      </aside>

      <main className="cp-main">
        <header className="cp-topbar">
          <div>
            <span>{t('header.workspace')}</span>
            <strong>{identity.workspace.name}</strong>
          </div>
          <Space size="medium">
            {standaloneLocale && (
              <Select
                aria-label={t('locale.label')}
                className="cp-locale-select"
                onChange={(value) => standaloneLocale.setPreference(value as LocalePreference)}
                options={[
                  { label: t('locale.system'), value: 'system' },
                  { label: t('locale.enUS'), value: 'en-US' },
                  { label: t('locale.zhCN'), value: 'zh-CN' },
                ]}
                value={standaloneLocale.preference}
              />
            )}
            <Button type="text" icon={<IconRefresh />} onClick={() => void refresh()}>
              {t('header.refresh')}
            </Button>
            <div className="cp-user">
              <Avatar size={30}>{identity.user.displayName.slice(0, 1).toUpperCase()}</Avatar>
              <span>
                <strong>{identity.user.displayName}</strong>
                <small>{t(`enums.role.${identity.workspace.role}`)}</small>
              </span>
            </div>
          </Space>
        </header>

        {error && (
          <Alert
            className="cp-alert"
            type="error"
            title={t('errors.catalogSyncFailed')}
            content={translateError(error)}
          />
        )}
        <div className="cp-content">
          <Routes>
            <Route
              path="/applications"
              element={
                <ApplicationsPage
                  identity={identity}
                  matrix={matrix}
                  pending={isPending}
                  notify={notify}
                  onChanged={refresh}
                />
              }
            />
            <Route path="/releases" element={<ReleasesPage workspaceId={identity.workspace.id} />} />
            <Route path="/channels" element={<ChannelsPage matrix={matrix} pending={isPending} />} />
            <Route path="/approvals" element={<ApprovalsPage identity={identity} notify={notify} />} />
            <Route path="*" element={<Navigate replace to="/applications" />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

function ControlNavLink({ icon, label, to }: { icon: React.ReactNode; label: string; to: string }) {
  return (
    <NavLink className={({ isActive }) => `cp-nav-link${isActive ? ' is-active' : ''}`} to={to}>
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}

function ApplicationsPage({
  identity,
  matrix,
  notify,
  onChanged,
  pending,
}: {
  identity: Identity;
  matrix: CatalogMatrix;
  notify: (message: string) => void;
  onChanged: () => Promise<unknown>;
  pending: boolean;
}) {
  const { formatDateTime, formatNumber, locale, t, translateError } = useControlPlaneI18n();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<ApplicationForm>();
  const queryClient = useQueryClient();
  const applications = useQuery({
    queryKey: ['applications', identity.workspace.id, locale.locale],
    queryFn: () => listApplications(identity.workspace.id, locale.locale),
  });
  const promotedApplications = useMemo(() => uniqueApplications(matrix), [matrix]);
  const mutation = useMutation({
    mutationFn: (values: ApplicationForm) =>
      createWebApplication({
        defaultLocale: values.defaultLocale,
        localizations: applicationLocalizations(values),
        name: values.name,
        slug: values.slug,
        summary: values.summary,
        workspaceId: identity.workspace.id,
        locale: locale.locale,
      }),
    onSuccess: async () => {
      notify(t('applications.registeredNotice'));
      setOpen(false);
      form.resetFields();
      await queryClient.invalidateQueries({ queryKey: ['applications', identity.workspace.id] });
      await onChanged();
    },
  });

  return (
    <>
      <SectionIntro
        eyebrow={t('applications.eyebrow')}
        title={
          <>
            {t('applications.titleLead')} <em>{t('applications.titleEmphasis')}</em>
          </>
        }
        description={t('applications.description')}
        action={
          <Button
            type="primary"
            icon={<IconPlus />}
            onClick={() => {
              if (!form.getFieldValue('defaultLocale')) form.setFieldValue('defaultLocale', locale.locale);
              setOpen(true);
            }}
          >
            {t('applications.register')}
          </Button>
        }
      />
      <div className="cp-metrics">
        <MetricCard
          label={t('applications.metrics.registered')}
          value={formatNumber(applications.data?.length ?? 0)}
          detail={t('applications.metrics.registeredDetail')}
        />
        <MetricCard
          label={t('applications.metrics.federation')}
          value={formatNumber(
            promotedApplications.filter((item) => item.manifest.runtime === 'federation').length,
          )}
          detail={t('applications.metrics.federationDetail')}
        />
        <MetricCard
          label={t('applications.metrics.isolated')}
          value={formatNumber(
            promotedApplications.filter((item) => item.manifest.runtime === 'iframe').length,
          )}
          detail={t('applications.metrics.isolatedDetail')}
        />
        <MetricCard
          label={t('applications.metrics.stable')}
          value={formatNumber(matrix.stable.length)}
          detail={t('applications.metrics.stableDetail')}
        />
      </div>
      {applications.isError && (
        <Alert className="cp-alert-inline" type="error" content={translateError(applications.error)} />
      )}
      <Card className="cp-table-card" bordered={false}>
        <Table
          loading={applications.isPending || pending}
          rowKey="id"
          pagination={false}
          data={applications.data ?? []}
          noDataElement={<div className="cp-empty-inline">{t('applications.empty')}</div>}
          columns={[
            {
              title: t('table.application'),
              render: (_, row: Application) => <RegisteredApplicationIdentity application={row} />,
            },
            {
              title: t('table.kind'),
              render: (_, row: Application) => <Tag bordered>{t(`enums.applicationKind.${row.kind}`)}</Tag>,
            },
            {
              title: t('table.stable'),
              render: (_, row: Application) => {
                const stable = matrix.stable.find((entry) => entry.applicationId === row.id);
                return stable ? <code>{stable.version}</code> : t('applications.notPromoted');
              },
            },
            {
              title: t('table.created'),
              render: (_, row: Application) => formatDateTime(row.createdAt),
            },
          ]}
        />
      </Card>

      <Modal
        title={t('applications.form.title')}
        visible={open}
        confirmLoading={mutation.isPending}
        onCancel={() => setOpen(false)}
        onOk={async () => mutation.mutate(await form.validate())}
      >
        {mutation.isError && <Alert type="error" content={translateError(mutation.error)} />}
        <Form form={form} initialValues={{ defaultLocale: locale.locale }} layout="vertical">
          <Form.Item
            field="defaultLocale"
            label={t('applications.form.defaultLocale')}
            rules={[{ required: true }]}
          >
            <Select
              options={[
                { label: t('locale.enUS'), value: 'en-US' },
                { label: t('locale.zhCN'), value: 'zh-CN' },
              ]}
            />
          </Form.Item>
          <Form.Item field="name" label={t('applications.form.defaultName')} rules={[{ required: true }]}>
            <Input placeholder={t('applications.form.namePlaceholder')} />
          </Form.Item>
          <Form.Item
            field="slug"
            label={t('applications.form.slug')}
            rules={[{ required: true, match: /^[a-z][a-z0-9-]+$/ }]}
          >
            <Input placeholder={t('applications.form.slugPlaceholder')} />
          </Form.Item>
          <Form.Item
            field="summary"
            label={t('applications.form.defaultSummary')}
            rules={[{ required: true }]}
          >
            <Input.TextArea placeholder={t('applications.form.summaryPlaceholder')} />
          </Form.Item>
          <div className="cp-form-section">
            <strong>{t('applications.form.translations')}</strong>
            <small>{t('applications.form.translationsDescription')}</small>
          </div>
          <div className="cp-localized-fields">
            <Form.Item field="enUSName" label={t('applications.form.enUSName')}>
              <Input allowClear />
            </Form.Item>
            <Form.Item field="enUSSummary" label={t('applications.form.enUSSummary')}>
              <Input.TextArea allowClear />
            </Form.Item>
            <Form.Item field="zhCNName" label={t('applications.form.zhCNName')}>
              <Input allowClear />
            </Form.Item>
            <Form.Item field="zhCNSummary" label={t('applications.form.zhCNSummary')}>
              <Input.TextArea allowClear />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </>
  );
}

function ReleasesPage({ workspaceId }: { workspaceId: string }) {
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

function ChannelsPage({ matrix, pending }: { matrix: CatalogMatrix; pending: boolean }) {
  const { formatNumber, localizeContent, t } = useControlPlaneI18n();
  return (
    <>
      <SectionIntro
        eyebrow={t('channels.eyebrow')}
        title={
          <>
            {t('channels.titleLead')} <em>{t('channels.titleEmphasis')}</em>
          </>
        }
        description={t('channels.description')}
      />
      <div className="cp-channel-grid">
        {CHANNELS.map((channel, index) => (
          <section className="cp-channel" key={channel}>
            <header>
              <span>0{index + 1}</span>
              <ChannelTag channel={channel} />
              <strong>{formatNumber(matrix[channel].length)}</strong>
            </header>
            {pending ? (
              <Skeleton animation text={{ rows: 4 }} />
            ) : matrix[channel].length === 0 ? (
              <div className="cp-channel__empty">{t('channels.empty')}</div>
            ) : (
              matrix[channel].map((entry) => {
                const content = localizeContent(entry, entry.localizations, entry.defaultLocale);
                return (
                  <article key={entry.releaseId} title={content.summary}>
                    <div>
                      <strong>{content.name}</strong>
                      <small>{entry.slug}</small>
                    </div>
                    <code>{entry.version}</code>
                  </article>
                );
              })
            )}
          </section>
        ))}
      </div>
    </>
  );
}

function ApprovalsPage({ identity, notify }: { identity: Identity; notify: (message: string) => void }) {
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

function ReleaseStatusPanel({ view }: { view: ReleaseStatusView }) {
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

function ReleaseStatusTag({ status }: { status: ReleaseStatus }) {
  const { t } = useControlPlaneI18n();
  const color =
    status === 'approved' ? 'green' : status === 'rejected' ? 'red' : status === 'ready' ? 'orange' : 'gray';
  return (
    <Tag bordered color={color}>
      {t(`enums.releaseStatus.${status}`)}
    </Tag>
  );
}

function RegisteredApplicationIdentity({ application }: { application: Application }) {
  const { localizeContent } = useControlPlaneI18n();
  const content = localizeContent(application, application.localizations, application.defaultLocale);
  return (
    <div className="cp-app-id">
      <strong>{content.name}</strong>
      <small className="cp-app-id__summary">{content.summary}</small>
      <span className="cp-block-id">{application.slug}</span>
    </div>
  );
}

function ReleaseApplicationIdentity({ item }: { item: ReleaseListItem }) {
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

function ReleaseRuntimeTag({ item }: { item: ReleaseListItem }) {
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

function ChannelTag({ channel }: { channel: ReleaseChannel }) {
  const { t } = useControlPlaneI18n();
  const color = channel === 'stable' ? 'green' : channel === 'canary' ? 'orange' : 'gray';
  return (
    <Tag bordered color={color}>
      {t(`enums.channel.${channel}`)}
    </Tag>
  );
}

function uniqueApplications(matrix: CatalogMatrix): CatalogEntry[] {
  const entries = [...matrix.stable, ...matrix.canary, ...matrix.dev];
  return [...new Map(entries.map((entry) => [entry.applicationId, entry])).values()];
}

type ApplicationForm = {
  defaultLocale: SupportedLocale;
  enUSName?: string;
  enUSSummary?: string;
  name: string;
  slug: string;
  summary: string;
  zhCNName?: string;
  zhCNSummary?: string;
};

function applicationLocalizations(values: ApplicationForm): ApplicationLocalizations {
  const enUS = compactLocalizedContent(values.enUSName, values.enUSSummary);
  const zhCN = compactLocalizedContent(values.zhCNName, values.zhCNSummary);
  return {
    ...(enUS ? { 'en-US': enUS } : {}),
    ...(zhCN ? { 'zh-CN': zhCN } : {}),
  };
}

function compactLocalizedContent(
  name: string | undefined,
  summary: string | undefined,
): { name?: string; summary?: string } | undefined {
  const normalizedName = name?.trim();
  const normalizedSummary = summary?.trim();
  if (!normalizedName && !normalizedSummary) return undefined;
  return {
    ...(normalizedName ? { name: normalizedName } : {}),
    ...(normalizedSummary ? { summary: normalizedSummary } : {}),
  };
}
