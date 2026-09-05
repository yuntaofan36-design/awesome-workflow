import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Select, Spin, Tag } from '@arco-design/web-react';
import {
  IconApps,
  IconDashboard,
  IconBranch,
  IconCode,
  IconHistory,
  IconRefresh,
  IconUpload,
} from '@arco-design/web-react/icon';
import { NavLink, Outlet } from 'react-router-dom';

import { formatUiError, normalizeUiError, type UiError } from '@/i18n/errors';
import { useLocale } from '@/i18n/localeContext';
import { developerApi, type DeveloperApplication, type DeveloperWorkspace } from '@/services/developerApi';
import {
  selectDeveloperApplication,
  selectDeveloperApplicationId,
  selectDeveloperWorkspace,
  selectDeveloperWorkspaceId,
  useDeveloperStore,
} from '@/stores/developerStore';
import '@/styles/developer-platform.css';

export function DeveloperPlatformLayout() {
  const { t } = useLocale();
  const workspaceId = useDeveloperStore(selectDeveloperWorkspaceId);
  const applicationId = useDeveloperStore(selectDeveloperApplicationId);
  const selectWorkspace = useDeveloperStore(selectDeveloperWorkspace);
  const selectApplication = useDeveloperStore(selectDeveloperApplication);
  const [workspaces, setWorkspaces] = useState<DeveloperWorkspace[]>([]);
  const [applications, setApplications] = useState<DeveloperApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<UiError | null>(null);

  const refreshApplications = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const values = await developerApi.listApplications(workspaceId);
      setApplications(values);
      if (!values.some((application) => application.id === applicationId)) {
        selectApplication(values[0]?.id ?? '');
      }
    } catch (reason) {
      setError(normalizeUiError(reason, 'developer_applications_failed'));
    } finally {
      setLoading(false);
    }
  }, [applicationId, selectApplication, workspaceId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void developerApi
      .listWorkspaces()
      .then((values) => {
        if (!active) return;
        setWorkspaces(values);
        if (!values.some((workspace) => workspace.id === workspaceId)) {
          selectWorkspace(values[0]?.id ?? '');
        }
      })
      .catch((reason: unknown) => active && setError(normalizeUiError(reason, 'api_request_failed')))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [selectWorkspace, workspaceId]);

  useEffect(() => {
    void refreshApplications();
  }, [refreshApplications]);

  const selectedApplication = applications.find((application) => application.id === applicationId) ?? null;
  const tabs = [
    { to: '/developer', end: true, label: t('developerPlatform.nav.applications'), icon: <IconApps /> },
    { to: '/developer/develop', label: t('developerPlatform.nav.develop'), icon: <IconCode /> },
    { to: '/developer/upload', label: t('developerPlatform.nav.upload'), icon: <IconUpload /> },
    { to: '/developer/versions', label: t('developerPlatform.nav.versions'), icon: <IconHistory /> },
    { to: '/developer/logs', label: t('developerPlatform.nav.logs'), icon: <IconBranch /> },
    { to: '/developer/analytics', label: t('developerPlatform.nav.analytics'), icon: <IconDashboard /> },
  ];

  return (
    <section className="developer-platform">
      <header className="developer-platform-hero">
        <div>
          <div className="developer-platform-kicker">
            <span>DEV / 04</span>
            <Tag color="green">{t('developerPlatform.workspaceTrust')}</Tag>
          </div>
          <h1>{t('developerPlatform.title')}</h1>
          <p>{t('developerPlatform.description')}</p>
        </div>
        <div className="developer-pulse" aria-label={t('developerPlatform.pipelineStatus')}>
          <i />
          <strong>{t('developerPlatform.pipelineReady')}</strong>
          <small>{t('developerPlatform.pipelineDetail')}</small>
        </div>
      </header>

      <div className="developer-command-bar">
        <label>
          <span>{t('developerPlatform.workspace')}</span>
          <Select
            value={workspaceId || undefined}
            loading={loading && workspaces.length === 0}
            placeholder={t('developerPlatform.chooseWorkspace')}
            onChange={selectWorkspace}
            options={workspaces.map((workspace) => ({ label: workspace.name, value: workspace.id }))}
          />
        </label>
        <label>
          <span>{t('developerPlatform.application')}</span>
          <Select
            value={applicationId || undefined}
            loading={loading}
            placeholder={t('developerPlatform.chooseApplication')}
            onChange={selectApplication}
            options={applications.map((application) => ({
              label: `${application.name} · ${application.slug}`,
              value: application.id,
            }))}
          />
        </label>
        <Button icon={<IconRefresh />} loading={loading} onClick={() => void refreshApplications()}>
          {t('common.refresh')}
        </Button>
      </div>

      <nav className="developer-tabs" aria-label={t('developerPlatform.navigationLabel')}>
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            end={tab.end}
            to={tab.to}
            className={({ isActive }) => (isActive ? 'is-active' : undefined)}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </NavLink>
        ))}
      </nav>

      {error && <Alert type="error" content={formatUiError(error, t)} />}
      {loading && applications.length === 0 ? (
        <div className="developer-route-loading">
          <Spin size={28} />
        </div>
      ) : (
        <Outlet context={{ applications, loading, refreshApplications, selectedApplication, workspaceId }} />
      )}
    </section>
  );
}
