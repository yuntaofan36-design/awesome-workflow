import type { ReactNode } from 'react';
import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Avatar, Badge, Button, Layout, Menu, Select, Space } from '@arco-design/web-react';
import {
  IconCalendar,
  IconCode,
  IconCloudDownload,
  IconDesktop,
  IconExperiment,
  IconHome,
  IconRefresh,
  IconSafe,
} from '@arco-design/web-react/icon';

import '@/styles/arco-app-shell';

import {
  selectDesktopLoading,
  selectDesktopError,
  selectRefreshDesktop,
  selectSnapshot,
  useDesktopStore,
} from '@/stores/desktopStore';
import { platformRoleLabel, taskStatusLabel } from '@/i18n/domain';
import { formatUiError } from '@/i18n/errors';
import { useLocale } from '@/i18n/localeContext';
import { selectCurrentUser, selectLogout, useSessionStore } from '@/stores/sessionStore';
import { LocaleSyncStatus } from './LocaleSyncStatus';

const { Header, Sider, Content } = Layout;
type AppShellProps = {
  children: ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const { formatNumber, preference, setPreference, t } = useLocale();
  const location = useLocation();
  const navigate = useNavigate();
  const currentUser = useSessionStore(selectCurrentUser);
  const logout = useSessionStore(selectLogout);
  const snapshot = useDesktopStore(selectSnapshot);
  const refresh = useDesktopStore(selectRefreshDesktop);
  const refreshing = useDesktopStore(selectDesktopLoading);
  const desktopError = useDesktopStore(selectDesktopError);
  const navigationItems = useMemo(
    () => [
      { key: '/dashboard', label: t('navigation.dashboard'), icon: <IconHome /> },
      { key: '/installed', label: t('navigation.installed'), icon: <IconDesktop /> },
      { key: '/tasks', label: t('navigation.tasks'), icon: <IconExperiment /> },
      { key: '/developer', label: t('navigation.developer'), icon: <IconCode /> },
      { key: '/schedules', label: t('navigation.schedules'), icon: <IconCalendar /> },
      { key: '/security', label: t('navigation.security'), icon: <IconSafe /> },
      { key: '/updates', label: t('navigation.updates'), icon: <IconCloudDownload /> },
    ],
    [t],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const displayName = currentUser?.displayName || currentUser?.email || t('app.guest');
  const avatarText = displayName.slice(0, 2).toUpperCase();

  const activeNavigationItem = useMemo(() => {
    const match = navigationItems.find((item) => location.pathname.startsWith(item.key));
    return match ?? navigationItems[0];
  }, [location.pathname, navigationItems]);

  const selectedKey = activeNavigationItem.key;
  const recentTasks = useMemo(
    () => [...(snapshot?.tasks ?? [])].sort((left, right) => right.startedAt - left.startedAt).slice(0, 4),
    [snapshot?.tasks],
  );
  const runningTasks = snapshot?.tasks.filter((task) => task.status === 'running').length ?? 0;

  return (
    <Layout className="desktop-frame">
      <Header className="desktop-header">
        <div className="brand-lockup">
          <div className="brand-mark">AW</div>
          <div className="brand-copy">
            <strong>AWESOME WORKFLOW</strong>
            <small>{t('app.brandSubtitle')}</small>
          </div>
        </div>
        <Menu
          mode="horizontal"
          className="desktop-top-nav border-0"
          selectedKeys={[selectedKey]}
          onClickMenuItem={(key) => navigate(String(key))}
        >
          {navigationItems.map((item) => (
            <Menu.Item key={item.key}>
              {item.icon}
              {item.label}
            </Menu.Item>
          ))}
        </Menu>
        <Space className="desktop-header-actions" size={12}>
          <Badge
            status={snapshot?.sync.offline ? 'warning' : 'success'}
            text={
              snapshot?.sync.offline
                ? t('app.offlineBadge')
                : t('app.revisionBadge', {
                    revision:
                      snapshot?.sync.revision === undefined ? '—' : formatNumber(snapshot.sync.revision),
                  })
            }
          >
            <span />
          </Badge>
          <Button
            aria-label={t('app.refreshAgent')}
            icon={<IconRefresh />}
            shape="circle"
            type="text"
            loading={refreshing}
            onClick={() => void refresh()}
          />
          <Select
            aria-label={t('locale.label')}
            size="small"
            style={{ width: 138 }}
            value={preference}
            onChange={(value) => {
              if (value === 'system' || value === 'en-US' || value === 'zh-CN') {
                void setPreference(value);
              }
            }}
            options={[
              { label: t('locale.system'), value: 'system' },
              { label: t('locale.enUS'), value: 'en-US' },
              { label: t('locale.zhCN'), value: 'zh-CN' },
            ]}
          />
          <LocaleSyncStatus />
          <button
            className="identity-button"
            type="button"
            onClick={() => void logout()}
            title={t('app.signOut')}
          >
            <Avatar size={30}>{avatarText}</Avatar>
            <span>
              {displayName}
              <small>
                {currentUser?.platformRoles[0]
                  ? platformRoleLabel(currentUser.platformRoles[0], t)
                  : t('app.signedIn')}
              </small>
            </span>
          </button>
        </Space>
      </Header>

      <Layout className="desktop-workspace-split">
        <Content className="desktop-content desktop-primary-pane">
          <div className="content-grid">
            {desktopError && <Alert type="error" content={formatUiError(desktopError, t)} />}
            {children}
          </div>
        </Content>

        <Sider width={360} className="desktop-utility-rail">
          <section className="utility-rail-section utility-rail-intro">
            <span>{t('app.utilityRail.eyebrow')}</span>
            <h2>{t('app.utilityRail.title')}</h2>
            <p>{t('app.utilityRail.description')}</p>
          </section>

          <section className="utility-rail-section">
            <header>
              <span>{t('app.utilityRail.quickActions')}</span>
            </header>
            <div className="utility-action-grid">
              <Button icon={<IconCode />} onClick={() => navigate('/developer')}>
                {t('navigation.developer')}
              </Button>
              <Button icon={<IconCalendar />} onClick={() => navigate('/schedules')}>
                {t('navigation.schedules')}
              </Button>
              <Button icon={<IconDesktop />} onClick={() => navigate('/installed')}>
                {t('navigation.installed')}
              </Button>
              <Button icon={<IconExperiment />} onClick={() => navigate('/tasks')}>
                {t('navigation.tasks')}
              </Button>
            </div>
          </section>

          <section className="utility-rail-section utility-runtime-card">
            <header>
              <span>{t('app.utilityRail.runtime')}</span>
              <Badge status={snapshot?.sync.offline ? 'warning' : 'success'} />
            </header>
            <div>
              <strong>{snapshot?.developerMode ? 'DEV' : 'MANAGED'}</strong>
              <small>{snapshot ? `${snapshot.target.os} / ${snapshot.target.arch}` : '—'}</small>
            </div>
            <dl>
              <div>
                <dt>{t('app.utilityRail.installed')}</dt>
                <dd>{formatNumber(snapshot?.installed.length ?? 0)}</dd>
              </div>
              <div>
                <dt>{t('app.utilityRail.running')}</dt>
                <dd>{formatNumber(runningTasks)}</dd>
              </div>
            </dl>
          </section>

          <section className="utility-rail-section utility-recent-tasks">
            <header>
              <span>{t('app.utilityRail.recentTasks')}</span>
              <Button type="text" size="mini" onClick={() => navigate('/tasks')}>
                {t('app.utilityRail.viewAll')}
              </Button>
            </header>
            {recentTasks.length === 0 ? (
              <p className="utility-empty">{t('app.utilityRail.noTasks')}</p>
            ) : (
              recentTasks.map((task) => (
                <button key={task.taskId} type="button" onClick={() => navigate('/tasks')}>
                  <span>
                    <strong>{task.appId}</strong>
                    <small>
                      {task.taskId.slice(0, 8)} · v{task.version}
                    </small>
                  </span>
                  <i className={`is-${task.status}`}>{taskStatusLabel(task.status, t)}</i>
                </button>
              ))
            )}
          </section>
        </Sider>
      </Layout>

      <footer className="desktop-status-bar">
        <span>{activeNavigationItem.label}</span>
        <span>
          {snapshot?.device ? t('app.utilityRail.deviceEnrolled') : t('app.utilityRail.deviceLocal')}
        </span>
        <span>{t('app.revisionBadge', { revision: snapshot?.sync.revision ?? '—' })}</span>
      </footer>
    </Layout>
  );
}
