import { useEffect, useState } from 'react';
import { Alert, Button, Input, Message, Progress, Select, Tag } from '@arco-design/web-react';
import { IconArrowRight, IconRefresh } from '@arco-design/web-react/icon';

import { apiRequest } from '@/services/apiClient';
import { desktopHost, isTauriRuntime } from '@/services/desktopHost';
import { selectRefreshDesktop, selectSnapshot, useDesktopStore } from '@/stores/desktopStore';

export function DashboardPage() {
  const snapshot = useDesktopStore(selectSnapshot);
  const refresh = useDesktopStore(selectRefreshDesktop);
  const running = snapshot?.tasks.filter((task) => task.status === 'running').length ?? 0;
  const failures = snapshot?.tasks.filter((task) => task.status === 'failed').length ?? 0;

  return (
    <section className="page-stack overview-page">
      <header className="overview-hero">
        <div>
          <div className="hero-meta">
            <span>01 / HOST STATUS</span>
            <Tag color={isTauriRuntime() ? 'green' : 'orange'}>
              {isTauriRuntime() ? 'TAURI' : 'BROWSER SIMULATION'}
            </Tag>
          </div>
          <h1>
            Local work,
            <br />
            <em>contained.</em>
          </h1>
        </div>
        <div className="host-orbit" aria-label="Agent status">
          <div>
            <strong>{snapshot?.sync.offline ? 'OFF' : 'ON'}</strong>
            <small>AGENT</small>
          </div>
          <span />
          <i />
        </div>
      </header>

      <div className="metric-rail">
        <Metric value={snapshot?.installed.length ?? 0} label="Installed versions" index="A" />
        <Metric value={running} label="Active runners" index="B" />
        <Metric value={snapshot?.sync.revision ?? 0} label="Schedule revision" index="C" />
        <Metric value={failures} label="Failed runs" index="D" danger={failures > 0} />
      </div>

      <DeviceEnrollmentPanel
        device={snapshot?.device ?? null}
        installationRevision={snapshot?.installationRevision ?? 0}
        target={snapshot?.target}
        onEnrolled={refresh}
      />

      <div className="overview-columns">
        <article className="surface boundary-map">
          <div className="surface-heading">
            <div>
              <p>EXECUTION BOUNDARY</p>
              <h2>Three processes, one narrow contract</h2>
            </div>
            <Button icon={<IconRefresh />} type="text" onClick={() => void refresh()}>
              Refresh
            </Button>
          </div>
          <div className="process-flow">
            <ProcessNode number="01" title="Tauri UI" detail="No Node · explicit invoke" />
            <IconArrowRight />
            <ProcessNode number="02" title="User Agent" detail="SQLite · policy · leases" active />
            <IconArrowRight />
            <ProcessNode number="03" title="Runner" detail="Minimal env · no token" />
          </div>
          <div className="contract-line">
            <code>protocolVersion</code>
            <i />
            <code>appId</code>
            <i />
            <code>taskId</code>
            <i />
            <code>lease</code>
            <i />
            <code>method</code>
          </div>
        </article>
        <article className="surface trust-score">
          <div className="surface-heading">
            <div>
              <p>LOCAL POSTURE</p>
              <h2>Trust controls</h2>
            </div>
            <strong>84</strong>
          </div>
          <Progress percent={84} showText={false} color="#c7ff3d" trailColor="#343a31" />
          <ul>
            <li>
              <span>Signed installation</span>
              <b>ENFORCED</b>
            </li>
            <li>
              <span>Lease-bound RPC</span>
              <b>ENFORCED</b>
            </li>
            <li>
              <span>Schedule freshness</span>
              <b>{snapshot?.sync.offline ? 'OFFLINE' : 'CURRENT'}</b>
            </li>
            <li>
              <span>OS process sandbox</span>
              <b className="warning">PHASE 2</b>
            </li>
          </ul>
        </article>
      </div>
    </section>
  );
}

type Workspace = { id: string; name: string; role: string };

function DeviceEnrollmentPanel({
  device,
  installationRevision,
  target,
  onEnrolled,
}: {
  device: { deviceId: string; apiBaseUrl: string } | null;
  installationRevision: number;
  target?: { os: string; arch: string };
  onEnrolled: () => Promise<void>;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [name, setName] = useState('My desktop');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (device || !isTauriRuntime()) return;
    let active = true;
    void apiRequest<Workspace[]>('/workspaces')
      .then((values) => {
        if (!active) return;
        setWorkspaces(values);
        setWorkspaceId(values[0]?.id ?? '');
      })
      .catch((reason: unknown) => active && setError(String(reason)));
    return () => {
      active = false;
    };
  }, [device]);

  if (device) {
    return (
      <article className="surface enrollment-card">
        <div className="surface-heading">
          <div>
            <p>DEVICE CONTROL PLANE</p>
            <h2>Automatic delivery is connected</h2>
          </div>
          <Tag color="green">ENROLLED</Tag>
        </div>
        <div className="contract-line">
          <code>{target ? `${target.os}-${target.arch}` : 'desktop'}</code>
          <i />
          <code>{device.deviceId}</code>
          <i />
          <code>INSTALL REV {installationRevision}</code>
        </div>
        <small className="muted">Signed releases are downloaded, verified and activated by the Agent.</small>
      </article>
    );
  }

  return (
    <article className="surface enrollment-card">
      <div className="surface-heading">
        <div>
          <p>DEVICE CONTROL PLANE</p>
          <h2>Enroll this Agent for automatic delivery</h2>
        </div>
        <Tag color="orange">ACTION REQUIRED</Tag>
      </div>
      <Alert
        type="info"
        content="Enrollment creates a device-scoped credential in the OS credential store. The WebView never receives it."
      />
      {error && <Alert type="error" content={error} />}
      <div className="field-pair">
        <Select
          value={workspaceId || undefined}
          placeholder="Choose workspace"
          onChange={setWorkspaceId}
          options={workspaces.map((workspace) => ({
            label: `${workspace.name} · ${workspace.role}`,
            value: workspace.id,
          }))}
        />
        <Input value={name} maxLength={120} onChange={setName} placeholder="Device name" />
      </div>
      <Button
        type="primary"
        loading={loading}
        disabled={!workspaceId || !name.trim()}
        onClick={() => {
          setLoading(true);
          setError(null);
          void desktopHost
            .enrollDevice(workspaceId, name.trim())
            .then(onEnrolled)
            .then(() => Message.success('Device enrolled'))
            .catch((reason: unknown) => setError(String(reason)))
            .finally(() => setLoading(false));
        }}
      >
        Enroll device
      </Button>
    </article>
  );
}

function Metric({
  value,
  label,
  index,
  danger = false,
}: {
  value: number;
  label: string;
  index: string;
  danger?: boolean;
}) {
  return (
    <div className={`metric-cell ${danger ? 'is-danger' : ''}`}>
      <span>{index}</span>
      <strong>{value.toString().padStart(2, '0')}</strong>
      <small>{label}</small>
    </div>
  );
}

function ProcessNode({
  number,
  title,
  detail,
  active = false,
}: {
  number: string;
  title: string;
  detail: string;
  active?: boolean;
}) {
  return (
    <div className={`process-node ${active ? 'is-active' : ''}`}>
      <span>{number}</span>
      <strong>{title}</strong>
      <small>{detail}</small>
    </div>
  );
}
