import {
  Alert,
  Avatar,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
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
  ReleaseListItem,
  ReleaseStatus,
  ReleaseStatusView,
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

const CHANNELS = ['dev', 'canary', 'stable'] as const;

type Identity = { theme: ThemeSnapshot; user: UserSummary; workspace: WorkspaceSummary };
type CatalogMatrix = Record<ReleaseChannel, CatalogEntry[]>;

export function ControlPlaneApp({ host, initialPath }: { host: HostApi; initialPath: string }) {
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
        <Alert type="error" title="Host context unavailable" content={identity.error.message} />
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
  return (
    <div className="cp-boot">
      <span>CONTROL PLANE / HANDSHAKE</span>
      <Skeleton animation text={{ rows: 4, width: ['36%', '72%', '58%', '44%'] }} />
    </div>
  );
}

function ControlPlaneFrame({ host, identity }: { host: HostApi; identity: Identity }) {
  const location = useLocation();
  const queries = useQueries({
    queries: CHANNELS.map((channel) => ({
      queryKey: ['catalog', identity.workspace.id, channel],
      queryFn: () => listCatalog(identity.workspace.id, channel),
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
        <div className="cp-rail__label">OPERATE</div>
        <ControlNavLink icon={<IconApps />} label="Applications" to="/applications" />
        <ControlNavLink icon={<IconBranch />} label="Releases" to="/releases" />
        <ControlNavLink icon={<IconExperiment />} label="Channels" to="/channels" />
        <ControlNavLink icon={<IconCheckCircle />} label="Approvals" to="/approvals" />
        <div className="cp-rail__footer">
          <SignalBadge tone={error ? 'danger' : isPending ? 'warning' : 'success'}>
            {error ? 'sync fault' : isPending ? 'syncing' : 'live catalog'}
          </SignalBadge>
        </div>
      </aside>

      <main className="cp-main">
        <header className="cp-topbar">
          <div>
            <span>WORKSPACE</span>
            <strong>{identity.workspace.name}</strong>
          </div>
          <Space size="medium">
            <Button type="text" icon={<IconRefresh />} onClick={() => void refresh()}>
              Refresh
            </Button>
            <div className="cp-user">
              <Avatar size={30}>{identity.user.displayName.slice(0, 1).toUpperCase()}</Avatar>
              <span>
                <strong>{identity.user.displayName}</strong>
                <small>{identity.workspace.role}</small>
              </span>
            </div>
          </Space>
        </header>

        {error && (
          <Alert
            className="cp-alert"
            type="error"
            title="Catalog synchronization failed"
            content={error.message}
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
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<ApplicationForm>();
  const queryClient = useQueryClient();
  const applications = useQuery({
    queryKey: ['applications', identity.workspace.id],
    queryFn: () => listApplications(identity.workspace.id),
  });
  const promotedApplications = useMemo(() => uniqueApplications(matrix), [matrix]);
  const mutation = useMutation({
    mutationFn: (values: ApplicationForm) =>
      createWebApplication({
        name: values.name,
        slug: values.slug,
        summary: values.summary,
        workspaceId: identity.workspace.id,
      }),
    onSuccess: async () => {
      notify('Application registered');
      setOpen(false);
      form.resetFields();
      await queryClient.invalidateQueries({ queryKey: ['applications', identity.workspace.id] });
      await onChanged();
    },
  });

  return (
    <>
      <SectionIntro
        eyebrow="Registry / Web applications"
        title={
          <>
            Every runtime has a <em>declared boundary.</em>
          </>
        }
        description="Federation is reserved for reviewed code, iframes run across an origin boundary, and links never execute inside the shell."
        action={
          <Button type="primary" icon={<IconPlus />} onClick={() => setOpen(true)}>
            Register application
          </Button>
        }
      />
      <div className="cp-metrics">
        <MetricCard
          label="registered"
          value={applications.data?.length ?? 0}
          detail="visible in this workspace"
        />
        <MetricCard
          label="federation"
          value={promotedApplications.filter((item) => item.manifest.runtime === 'federation').length}
          detail="promoted trusted runtimes"
        />
        <MetricCard
          label="isolated"
          value={promotedApplications.filter((item) => item.manifest.runtime === 'iframe').length}
          detail="promoted cross-origin frames"
        />
        <MetricCard label="stable" value={matrix.stable.length} detail="production channel entries" />
      </div>
      {applications.isError && (
        <Alert className="cp-alert-inline" type="error" content={applications.error.message} />
      )}
      <Card className="cp-table-card" bordered={false}>
        <Table
          loading={applications.isPending || pending}
          rowKey="id"
          pagination={false}
          data={applications.data ?? []}
          noDataElement={<div className="cp-empty-inline">No application is registered yet.</div>}
          columns={[
            {
              title: 'APPLICATION',
              render: (_, row: Application) => <RegisteredApplicationIdentity application={row} />,
            },
            {
              title: 'KIND',
              render: (_, row: Application) => <Tag bordered>{row.kind}</Tag>,
            },
            {
              title: 'STABLE',
              render: (_, row: Application) => {
                const stable = matrix.stable.find((entry) => entry.applicationId === row.id);
                return stable ? <code>{stable.version}</code> : 'Not promoted';
              },
            },
            {
              title: 'CREATED',
              render: (_, row: Application) => formatDate(row.createdAt),
            },
          ]}
        />
      </Card>

      <Modal
        title="Register web application"
        visible={open}
        confirmLoading={mutation.isPending}
        onCancel={() => setOpen(false)}
        onOk={async () => mutation.mutate(await form.validate())}
      >
        {mutation.isError && <Alert type="error" content={mutation.error.message} />}
        <Form form={form} layout="vertical">
          <Form.Item field="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="Deployment radar" />
          </Form.Item>
          <Form.Item field="slug" label="Slug" rules={[{ required: true, match: /^[a-z][a-z0-9-]+$/ }]}>
            <Input placeholder="deployment-radar" />
          </Form.Item>
          <Form.Item field="summary" label="Summary" rules={[{ required: true }]}>
            <Input.TextArea placeholder="What the application does" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function ReleasesPage({ workspaceId }: { workspaceId: string }) {
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);
  const releases = useQuery({
    queryKey: ['releases', workspaceId, 'web'],
    queryFn: () => listReleases(workspaceId, { kind: 'web' }),
  });
  const status = useQuery({
    queryKey: ['release-status', selectedReleaseId],
    queryFn: () => getReleaseStatus(selectedReleaseId!),
    enabled: selectedReleaseId !== null,
    retry: false,
  });

  return (
    <>
      <SectionIntro
        eyebrow="Supply chain / Signed release workflow"
        title={
          <>
            Package once. <em>Verify every byte.</em>
          </>
        }
        description="A release is not published by submitting a URL. The signed artifact and its SBOM must both be uploaded, finalized, and submitted to the validation worker."
      />
      <Card className="cp-workflow-card" bordered={false}>
        <Alert
          type="info"
          title="Publishing is intentionally delegated to the signed CLI workflow"
          content="This browser does not have access to publisher private keys and does not emulate artifact or SBOM uploads. Run the commands below from the micro-app project."
        />
        <ol className="cp-release-steps">
          <li>
            Build and sign the immutable package:{' '}
            <code>aw package --key-id &lt;key-id&gt; --private-key &lt;key.pem&gt;</code>
          </li>
          <li>
            Authenticate without a long-lived token: <code>aw login --api &lt;api-url&gt;</code>
          </li>
          <li>
            Create, upload artifact + SBOM, finalize, and submit:{' '}
            <code>aw publish --application-id &lt;uuid&gt;</code>
          </li>
        </ol>
        <small className="cp-contract-note">
          The server lifecycle is draft → uploading → validating → ready → approved/rejected. No channel is
          selected while creating a release.
        </small>
      </Card>

      <div className="cp-table-heading">
        <div>
          <span>IMMUTABLE RELEASES</span>
          <h3>Workspace release history</h3>
        </div>
        <small>Draft, upload, validation and review state come directly from the control plane.</small>
      </div>
      {releases.isError && (
        <Alert className="cp-alert-inline" type="error" content={releases.error.message} />
      )}
      <Card className="cp-table-card" bordered={false}>
        <Table
          loading={releases.isPending}
          rowKey={(row) => row.release.id}
          data={releases.data ?? []}
          pagination={{ pageSize: 10 }}
          noDataElement={<div className="cp-empty-inline">No signed release has been created yet.</div>}
          columns={[
            {
              title: 'APPLICATION',
              render: (_, row: ReleaseListItem) => <ReleaseApplicationIdentity item={row} />,
            },
            { title: 'VERSION', render: (_, row: ReleaseListItem) => <code>{row.release.version}</code> },
            {
              title: 'STATUS',
              render: (_, row: ReleaseListItem) => <ReleaseStatusTag status={row.release.status} />,
            },
            {
              title: 'RUNTIME',
              render: (_, row: ReleaseListItem) => <ReleaseRuntimeTag item={row} />,
            },
            { title: 'ARTIFACTS', dataIndex: 'artifactCount' },
            {
              title: 'CREATED',
              render: (_, row: ReleaseListItem) => formatDate(row.release.createdAt),
            },
            {
              title: '',
              render: (_, row: ReleaseListItem) => (
                <Button size="small" onClick={() => setSelectedReleaseId(row.release.id)}>
                  Inspect evidence
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {status.isFetching && <Skeleton className="cp-inspector" animation text={{ rows: 4 }} />}
      {status.isError && <Alert className="cp-alert-inline" type="error" content={status.error.message} />}
      {status.data && <ReleaseStatusPanel view={status.data} />}
    </>
  );
}

function ChannelsPage({ matrix, pending }: { matrix: CatalogMatrix; pending: boolean }) {
  return (
    <>
      <SectionIntro
        eyebrow="Delivery / Release channels"
        title={
          <>
            Three gates, one <em>release identity.</em>
          </>
        }
        description="Development absorbs change, canary proves behavior, and stable serves production. No artifact is rebuilt between gates."
      />
      <div className="cp-channel-grid">
        {CHANNELS.map((channel, index) => (
          <section className="cp-channel" key={channel}>
            <header>
              <span>0{index + 1}</span>
              <ChannelTag channel={channel} />
              <strong>{matrix[channel].length}</strong>
            </header>
            {pending ? (
              <Skeleton animation text={{ rows: 4 }} />
            ) : matrix[channel].length === 0 ? (
              <div className="cp-channel__empty">No release assigned</div>
            ) : (
              matrix[channel].map((entry) => (
                <article key={entry.releaseId}>
                  <div>
                    <strong>{entry.name}</strong>
                    <small>{entry.slug}</small>
                  </div>
                  <code>{entry.version}</code>
                </article>
              ))
            )}
          </section>
        ))}
      </div>
    </>
  );
}

function ApprovalsPage({ identity, notify }: { identity: Identity; notify: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const queue = useQuery({
    queryKey: ['review-queue', identity.workspace.id, 'web'],
    queryFn: () => listPendingReviews(identity.workspace.id, 'web'),
  });
  const status = useQuery({
    queryKey: ['release-status', selectedReleaseId],
    queryFn: () => getReleaseStatus(selectedReleaseId!),
    enabled: selectedReleaseId !== null,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => {
      if (!selectedReleaseId) throw new Error('Select a pending release before recording a review');
      return reviewRelease({ comment, decision, releaseId: selectedReleaseId });
    },
    onSuccess: async (view, decision) => {
      queryClient.setQueryData(['release-status', view.release.id], view);
      notify(decision === 'approve' ? 'Approval recorded' : 'Rejection recorded');
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
        eyebrow="Governance / Release review"
        title={
          <>
            Human judgment before <em>channel movement.</em>
          </>
        }
        description="A review changes a validated release from ready to approved or rejected. It does not promote a channel pointer."
      />
      {!canReview && (
        <Alert
          className="cp-alert-inline"
          type="warning"
          content="You can inspect release evidence, but only PlatformAdmin or OfficialReviewer can record a review. Workspace Owner/Admin alone is not review authority."
        />
      )}
      {queue.isError && <Alert className="cp-alert-inline" type="error" content={queue.error.message} />}
      <Card className="cp-table-card" bordered={false}>
        <Table
          loading={queue.isPending}
          rowKey={(row) => row.release.id}
          data={queue.data ?? []}
          pagination={{ pageSize: 10 }}
          noDataElement={
            <div className="cp-empty-queue">
              <IconCheckCircle />
              No validated release is waiting for review.
            </div>
          }
          columns={[
            {
              title: 'APPLICATION',
              render: (_, row: ReleaseListItem) => <ReleaseApplicationIdentity item={row} />,
            },
            { title: 'VERSION', render: (_, row: ReleaseListItem) => <code>{row.release.version}</code> },
            {
              title: 'EVIDENCE',
              render: (_, row: ReleaseListItem) => row.release.validationEvidence.length,
            },
            { title: 'ARTIFACTS', dataIndex: 'artifactCount' },
            {
              title: 'CREATED',
              render: (_, row: ReleaseListItem) => formatDate(row.release.createdAt),
            },
            {
              title: '',
              render: (_, row: ReleaseListItem) => (
                <Button size="small" onClick={() => setSelectedReleaseId(row.release.id)}>
                  Review evidence
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {status.isFetching && <Skeleton className="cp-inspector" animation text={{ rows: 4 }} />}
      {status.isError && <Alert className="cp-alert-inline" type="error" content={status.error.message} />}
      {status.data && (
        <section className="cp-inspector">
          <>
            <ReleaseStatusPanel view={status.data} />
            <Card className="cp-review-card" bordered={false}>
              <header>
                <div>
                  <span>REVIEW DECISION</span>
                  <h3>
                    {isReady ? 'Validation complete — decision required' : `Release is ${release?.status}`}
                  </h3>
                </div>
                {release && <ReleaseStatusTag status={release.status} />}
              </header>
              {!isReady && (
                <Alert
                  type="warning"
                  content="The review API accepts only a ready release. Refresh after validation completes; approved or rejected releases cannot be reviewed again."
                />
              )}
              {mutation.isError && <Alert type="error" content={mutation.error.message} />}
              <Input.TextArea
                disabled={!canReview || !isReady}
                maxLength={1000}
                onChange={setComment}
                placeholder="Evidence-based reviewer comment (optional)"
                showWordLimit
                value={comment}
              />
              <Space className="cp-review-actions">
                <Popconfirm
                  disabled={!canReview || !isReady}
                  title={`Approve release ${release?.version ?? ''}?`}
                  onOk={() => mutation.mutate('approve')}
                >
                  <Button
                    type="primary"
                    disabled={!canReview || !isReady}
                    loading={mutation.isPending}
                    icon={<IconCheckCircle />}
                  >
                    Record approval
                  </Button>
                </Popconfirm>
                <Popconfirm
                  disabled={!canReview || !isReady}
                  title={`Reject release ${release?.version ?? ''}?`}
                  onOk={() => mutation.mutate('reject')}
                >
                  <Button status="danger" disabled={!canReview || !isReady} loading={mutation.isPending}>
                    Record rejection
                  </Button>
                </Popconfirm>
              </Space>
              <small className="cp-contract-note">
                After approval, an Owner/Admin must promote the immutable release separately with{' '}
                <code>aw promote</code> and an optimistic <code>expectedCurrentReleaseId</code>.
              </small>
            </Card>
          </>
        </section>
      )}
    </>
  );
}

function ReleaseStatusPanel({ view }: { view: ReleaseStatusView }) {
  return (
    <Card className="cp-release-status" bordered={false}>
      <header>
        <div>
          <span>SERVER RELEASE STATUS</span>
          <h3>{view.release.version}</h3>
          <code>{view.release.id}</code>
        </div>
        <ReleaseStatusTag status={view.release.status} />
      </header>
      <div className="cp-release-facts">
        <div>
          <span>APPLICATION</span>
          <code>{view.release.applicationId}</code>
        </div>
        <div>
          <span>MANIFEST</span>
          <strong>{view.release.manifest.kind}</strong>
        </div>
        <div>
          <span>ARTIFACTS</span>
          <strong>{view.artifacts.length}</strong>
        </div>
        <div>
          <span>REVIEWS</span>
          <strong>{view.reviews.length}</strong>
        </div>
      </div>
      <Table
        border={{ cell: true }}
        data={view.artifacts}
        pagination={false}
        rowKey="id"
        noDataElement={<div className="cp-empty-inline">No artifact upload has been registered.</div>}
        columns={[
          { title: 'ARTIFACT', dataIndex: 'fileName' },
          { title: 'SIZE', dataIndex: 'size', render: (size: number) => formatBytes(size) },
          { title: 'STATUS', dataIndex: 'status', render: (status: string) => <Tag bordered>{status}</Tag> },
          {
            title: 'FINALIZED',
            dataIndex: 'finalizedAt',
            render: (value?: string) => (value ? formatDate(value) : '—'),
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
              title: 'DECISION',
              dataIndex: 'decision',
              render: (decision: string) => (
                <Tag color={decision === 'approve' ? 'green' : 'red'}>{decision}</Tag>
              ),
            },
            { title: 'COMMENT', dataIndex: 'comment', render: (value: string) => value || '—' },
            { title: 'RECORDED', dataIndex: 'createdAt', render: (value: string) => formatDate(value) },
          ]}
        />
      )}
    </Card>
  );
}

function ReleaseStatusTag({ status }: { status: ReleaseStatus }) {
  const color =
    status === 'approved' ? 'green' : status === 'rejected' ? 'red' : status === 'ready' ? 'orange' : 'gray';
  return (
    <Tag bordered color={color}>
      {status}
    </Tag>
  );
}

function AppIdentity({ entry }: { entry: CatalogEntry }) {
  return (
    <div className="cp-app-id">
      <strong>{entry.name}</strong>
      <small>{entry.slug}</small>
    </div>
  );
}

function RegisteredApplicationIdentity({ application }: { application: Application }) {
  return (
    <div className="cp-app-id">
      <strong>{application.name}</strong>
      <small>{application.slug}</small>
    </div>
  );
}

function ReleaseApplicationIdentity({ item }: { item: ReleaseListItem }) {
  return (
    <div className="cp-app-id">
      <strong>{item.application.name}</strong>
      <small>{item.application.slug}</small>
    </div>
  );
}

function ReleaseRuntimeTag({ item }: { item: ReleaseListItem }) {
  if (item.release.manifest.kind !== 'web') return <Tag bordered>desktop</Tag>;
  return <RuntimeTag runtime={item.release.manifest.runtime} />;
}

function RuntimeTag({ runtime }: { runtime: WebManifest['runtime'] }) {
  return (
    <Tag bordered color={runtime === 'federation' ? 'lime' : runtime === 'iframe' ? 'arcoblue' : 'gray'}>
      {runtime}
    </Tag>
  );
}

function ChannelTag({ channel }: { channel: ReleaseChannel }) {
  const color = channel === 'stable' ? 'green' : channel === 'canary' ? 'orange' : 'gray';
  return (
    <Tag bordered color={color}>
      {channel}
    </Tag>
  );
}

function uniqueApplications(matrix: CatalogMatrix): CatalogEntry[] {
  const entries = [...matrix.stable, ...matrix.canary, ...matrix.dev];
  return [...new Map(entries.map((entry) => [entry.applicationId, entry])).values()];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

type ApplicationForm = {
  name: string;
  slug: string;
  summary: string;
};
