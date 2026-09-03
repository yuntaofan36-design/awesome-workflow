import { useEffect, useState } from 'react';
import { Alert, Button, Input, Message, Progress, Select, Tag } from '@arco-design/web-react';
import { IconArrowRight, IconRefresh } from '@arco-design/web-react/icon';

import '@arco-design/web-react/es/Input/style/css.js';
import '@arco-design/web-react/es/Progress/style/css.js';
import '@arco-design/web-react/es/Tag/style/css.js';

import { apiRequest } from '@/services/apiClient';
import { desktopHost, isTauriRuntime } from '@/services/desktopHost';
import { platformLabel, workspaceRoleLabel } from '@/i18n/domain';
import { formatUiError, normalizeUiError, type UiError } from '@/i18n/errors';
import { useLocale } from '@/i18n/localeContext';
import { selectRefreshDesktop, selectSnapshot, useDesktopStore } from '@/stores/desktopStore';
import type { DesktopPlatform } from '@/types';

export function DashboardPage() {
  const { formatNumber, t } = useLocale();
  const snapshot = useDesktopStore(selectSnapshot);
  const refresh = useDesktopStore(selectRefreshDesktop);
  const running = snapshot?.tasks.filter((task) => task.status === 'running').length ?? 0;
  const failures = snapshot?.tasks.filter((task) => task.status === 'failed').length ?? 0;

  return (
    <section className="page-stack overview-page">
      <header className="overview-hero">
        <div>
          <div className="hero-meta">
            <span>{t('dashboard.meta')}</span>
            <Tag color={isTauriRuntime() ? 'green' : 'orange'}>
              {isTauriRuntime() ? t('dashboard.tauri') : t('dashboard.browserSimulation')}
            </Tag>
          </div>
          <h1>
            {t('dashboard.headlineLine1')}
            <br />
            <em>{t('dashboard.headlineLine2')}</em>
          </h1>
        </div>
        <div className="host-orbit" aria-label={t('dashboard.agentStatus')}>
          <div>
            <strong>{snapshot?.sync.offline ? t('dashboard.off') : t('dashboard.on')}</strong>
            <small>{t('dashboard.agent')}</small>
          </div>
          <span />
          <i />
        </div>
      </header>

      <div className="metric-rail">
        <Metric value={snapshot?.installed.length ?? 0} label={t('dashboard.metrics.installed')} index="A" />
        <Metric value={running} label={t('dashboard.metrics.runners')} index="B" />
        <Metric value={snapshot?.sync.revision ?? 0} label={t('dashboard.metrics.revision')} index="C" />
        <Metric value={failures} label={t('dashboard.metrics.failures')} index="D" danger={failures > 0} />
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
              <p>{t('dashboard.executionBoundary')}</p>
              <h2>{t('dashboard.processTitle')}</h2>
            </div>
            <Button icon={<IconRefresh />} type="text" onClick={() => void refresh()}>
              {t('common.refresh')}
            </Button>
          </div>
          <div className="process-flow">
            <ProcessNode
              number="01"
              title={t('dashboard.processes.tauri')}
              detail={t('dashboard.processes.tauriDetail')}
            />
            <IconArrowRight />
            <ProcessNode
              number="02"
              title={t('dashboard.processes.agent')}
              detail={t('dashboard.processes.agentDetail')}
              active
            />
            <IconArrowRight />
            <ProcessNode
              number="03"
              title={t('dashboard.processes.runner')}
              detail={t('dashboard.processes.runnerDetail')}
            />
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
              <p>{t('dashboard.posture')}</p>
              <h2>{t('dashboard.trustControls')}</h2>
            </div>
            <strong>{formatNumber(84)}</strong>
          </div>
          <Progress percent={84} showText={false} color="#c7ff3d" trailColor="#343a31" />
          <ul>
            <li>
              <span>{t('dashboard.controls.signedInstallation')}</span>
              <b>{t('dashboard.enforced')}</b>
            </li>
            <li>
              <span>{t('dashboard.controls.leaseBoundRpc')}</span>
              <b>{t('dashboard.enforced')}</b>
            </li>
            <li>
              <span>{t('dashboard.controls.scheduleFreshness')}</span>
              <b>{snapshot?.sync.offline ? t('dashboard.offline') : t('dashboard.current')}</b>
            </li>
            <li>
              <span>{t('dashboard.controls.processSandbox')}</span>
              <b className="warning">{t('dashboard.phase2')}</b>
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
  target?: DesktopPlatform;
  onEnrolled: () => Promise<void>;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const { formatNumber, t } = useLocale();
  const defaultDeviceName = t('dashboard.defaultDeviceName');
  const [name, setName] = useState(defaultDeviceName);
  const [nameCustomized, setNameCustomized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<UiError | null>(null);

  useEffect(() => {
    if (!nameCustomized) setName(defaultDeviceName);
  }, [defaultDeviceName, nameCustomized]);

  useEffect(() => {
    if (device || !isTauriRuntime()) return;
    let active = true;
    void apiRequest<Workspace[]>('/workspaces')
      .then((values) => {
        if (!active) return;
        setWorkspaces(values);
        setWorkspaceId(values[0]?.id ?? '');
      })
      .catch((reason: unknown) => active && setError(normalizeUiError(reason, 'api_request_failed')));
    return () => {
      active = false;
    };
  }, [device]);

  if (device) {
    return (
      <article className="surface enrollment-card">
        <div className="surface-heading">
          <div>
            <p>{t('dashboard.deviceControlPlane')}</p>
            <h2>{t('dashboard.deliveryConnected')}</h2>
          </div>
          <Tag color="green">{t('dashboard.enrolled')}</Tag>
        </div>
        <div className="contract-line">
          <code>{target ? platformLabel(target, t) : t('app.brandSubtitle')}</code>
          <i />
          <code>{device.deviceId}</code>
          <i />
          <code>{t('dashboard.installRevision', { revision: formatNumber(installationRevision) })}</code>
        </div>
        <small className="muted">{t('dashboard.signedDelivery')}</small>
      </article>
    );
  }

  return (
    <article className="surface enrollment-card">
      <div className="surface-heading">
        <div>
          <p>{t('dashboard.deviceControlPlane')}</p>
          <h2>{t('dashboard.enrollTitle')}</h2>
        </div>
        <Tag color="orange">{t('dashboard.actionRequired')}</Tag>
      </div>
      <Alert type="info" content={t('dashboard.enrollDescription')} />
      {error && <Alert type="error" content={formatUiError(error, t)} />}
      <div className="field-pair">
        <Select
          value={workspaceId || undefined}
          placeholder={t('dashboard.chooseWorkspace')}
          onChange={setWorkspaceId}
          options={workspaces.map((workspace) => ({
            label: `${workspace.name} · ${workspaceRoleLabel(workspace.role, t)}`,
            value: workspace.id,
          }))}
        />
        <Input
          value={name}
          maxLength={120}
          onChange={(value) => {
            setNameCustomized(true);
            setName(value);
          }}
          placeholder={t('dashboard.deviceName')}
        />
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
            .then(() => Message.success(t('dashboard.enrolledMessage')))
            .catch((reason: unknown) => setError(normalizeUiError(reason, 'device_enrollment_failed')))
            .finally(() => setLoading(false));
        }}
      >
        {t('dashboard.enrollDevice')}
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
  const { formatNumber } = useLocale();
  return (
    <div className={`metric-cell ${danger ? 'is-danger' : ''}`}>
      <span>{index}</span>
      <strong>{formatNumber(value, { minimumIntegerDigits: 2, useGrouping: false })}</strong>
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
