import { Alert, Avatar, Button, Select, Skeleton, Space } from '@arco-design/web-react';
import {
  IconApps,
  IconBranch,
  IconCheckCircle,
  IconExperiment,
  IconRefresh,
} from '@arco-design/web-react/icon';
import type { LocalePreference } from '@awesome-workflow/contracts';
import { SignalBadge } from '@awesome-workflow/ui';
import type { HostApi, ThemeSnapshot } from '@awesome-workflow/web-sdk';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { MemoryRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';

import { listCatalog } from './api/catalog';
import { CHANNELS, type CatalogMatrix, type Identity } from './controlPlaneTypes';
import { useControlPlaneI18n } from './i18n';

const loadApplicationsPage = () => import('./pages/ApplicationsPage');
const loadReleasesPage = () => import('./pages/ReleasesPage');
const loadChannelsPage = () => import('./pages/ChannelsPage');
const loadApprovalsPage = () => import('./pages/ApprovalsPage');

const ApplicationsPage = lazy(loadApplicationsPage);
const ReleasesPage = lazy(loadReleasesPage);
const ChannelsPage = lazy(loadChannelsPage);
const ApprovalsPage = lazy(loadApprovalsPage);

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

  if (identity.isPending) return <ControlPlaneBoot />;
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
    <div className="cp-boot" aria-live="polite">
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
        <ControlNavLink
          icon={<IconApps />}
          label={t('navigation.applications')}
          preload={loadApplicationsPage}
          to="/applications"
        />
        <ControlNavLink
          icon={<IconBranch />}
          label={t('navigation.releases')}
          preload={loadReleasesPage}
          to="/releases"
        />
        <ControlNavLink
          icon={<IconExperiment />}
          label={t('navigation.channels')}
          preload={loadChannelsPage}
          to="/channels"
        />
        <ControlNavLink
          icon={<IconCheckCircle />}
          label={t('navigation.approvals')}
          preload={loadApprovalsPage}
          to="/approvals"
        />
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
          <Suspense fallback={<RoutePending />}>
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
          </Suspense>
        </div>
      </main>
    </div>
  );
}

function RoutePending() {
  return (
    <div className="cp-route-pending" aria-busy="true" aria-live="polite">
      <Skeleton animation text={{ rows: 6, width: ['34%', '78%', '72%', '86%', '62%', '48%'] }} />
    </div>
  );
}

function ControlNavLink({
  icon,
  label,
  preload,
  to,
}: {
  icon: ReactNode;
  label: string;
  preload: () => Promise<unknown>;
  to: string;
}) {
  const warmRoute = () => {
    void preload().catch(() => undefined);
  };
  return (
    <NavLink
      className={({ isActive }) => `cp-nav-link${isActive ? ' is-active' : ''}`}
      onFocus={warmRoute}
      onPointerEnter={warmRoute}
      to={to}
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}
