import type { ReactNode } from 'react';
import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Alert,
  Avatar,
  Badge,
  Breadcrumb,
  Button,
  Layout,
  Menu,
  Select,
  Space,
} from '@arco-design/web-react';
import {
  IconCalendar,
  IconCode,
  IconCloudDownload,
  IconDesktop,
  IconExperiment,
  IconHome,
  IconMenuFold,
  IconMenuUnfold,
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
import { platformRoleLabel } from '@/i18n/domain';
import { formatUiError } from '@/i18n/errors';
import { useLocale } from '@/i18n/localeContext';
import { selectCurrentUser, selectLogout, useSessionStore } from '@/stores/sessionStore';
import { selectSidebarCollapsed, selectToggleSidebar, useWorkspaceStore } from '@/stores/workspaceStore';
import { LocaleSyncStatus } from './LocaleSyncStatus';

const { Header, Sider, Content } = Layout;
type AppShellProps = {
  children: ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const { formatNumber, preference, setPreference, t } = useLocale();
  const location = useLocation();
  const navigate = useNavigate();
  const collapsed = useWorkspaceStore(selectSidebarCollapsed);
  const toggleSidebar = useWorkspaceStore(selectToggleSidebar);
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

  return (
    <Layout className="desktop-frame">
      <Sider
        breakpoint="lg"
        collapsed={collapsed}
        collapsedWidth={56}
        collapsible
        trigger={null}
        width={236}
        className="app-sidebar"
      >
        <div className={`brand-lockup ${collapsed ? 'is-collapsed' : ''}`}>
          <div className="brand-mark">AW</div>
          {!collapsed && (
            <div className="brand-copy">
              <strong>
                AWESOME
                <br />
                WORKFLOW
              </strong>
              <small>{t('app.brandSubtitle')}</small>
            </div>
          )}
        </div>
        <Menu
          className="app-sidebar-menu border-0"
          collapse={collapsed}
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
      </Sider>

      <Layout>
        <Header className="desktop-header">
          <Space size={12}>
            <Button
              aria-label={collapsed ? t('app.expandNavigation') : t('app.collapseNavigation')}
              icon={collapsed ? <IconMenuUnfold /> : <IconMenuFold />}
              shape="circle"
              type="text"
              onClick={toggleSidebar}
            />
            <Breadcrumb className="min-w-0 text-sm">
              <Breadcrumb.Item>
                <button type="button" className="breadcrumb-root" onClick={() => navigate('/dashboard')}>
                  {t('app.localControlPlane')}
                </button>
              </Breadcrumb.Item>
              <Breadcrumb.Item>{activeNavigationItem.label}</Breadcrumb.Item>
            </Breadcrumb>
          </Space>
          <Space size={16}>
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
        <Content className="desktop-content">
          <div className="content-grid">
            {desktopError && <Alert type="error" content={formatUiError(desktopError, t)} />}
            {children}
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
