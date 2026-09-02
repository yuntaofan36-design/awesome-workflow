import type { ReactNode } from 'react';
import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Avatar, Badge, Breadcrumb, Button, Layout, Menu, Space } from '@arco-design/web-react';
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

import {
  selectDesktopLoading,
  selectRefreshDesktop,
  selectSnapshot,
  useDesktopStore,
} from '@/stores/desktopStore';
import { selectCurrentUser, selectLogout, useSessionStore } from '@/stores/sessionStore';
import { selectSidebarCollapsed, selectToggleSidebar, useWorkspaceStore } from '@/stores/workspaceStore';

const { Header, Sider, Content } = Layout;
type AppShellProps = {
  children: ReactNode;
};

const navigationItems = [
  { key: '/dashboard', label: 'Host overview', icon: <IconHome /> },
  { key: '/installed', label: 'Installed', icon: <IconDesktop /> },
  { key: '/tasks', label: 'Runs & logs', icon: <IconExperiment /> },
  { key: '/developer', label: 'Developer', icon: <IconCode /> },
  { key: '/schedules', label: 'Schedules', icon: <IconCalendar /> },
  { key: '/security', label: 'Trust center', icon: <IconSafe /> },
  { key: '/updates', label: 'Desktop updates', icon: <IconCloudDownload /> },
] as const;

export function AppShell({ children }: AppShellProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const collapsed = useWorkspaceStore(selectSidebarCollapsed);
  const toggleSidebar = useWorkspaceStore(selectToggleSidebar);
  const currentUser = useSessionStore(selectCurrentUser);
  const logout = useSessionStore(selectLogout);
  const snapshot = useDesktopStore(selectSnapshot);
  const refresh = useDesktopStore(selectRefreshDesktop);
  const refreshing = useDesktopStore(selectDesktopLoading);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const displayName = currentUser?.displayName || currentUser?.email || 'Guest';
  const avatarText = displayName.slice(0, 2).toUpperCase();

  const activeNavigationItem = useMemo(() => {
    const match = navigationItems.find((item) => location.pathname.startsWith(item.key));
    return match ?? navigationItems[0];
  }, [location.pathname]);

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
              <small>DESKTOP HOST</small>
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
              aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
              icon={collapsed ? <IconMenuUnfold /> : <IconMenuFold />}
              shape="circle"
              type="text"
              onClick={toggleSidebar}
            />
            <Breadcrumb className="min-w-0 text-sm">
              <Breadcrumb.Item>
                <button type="button" className="breadcrumb-root" onClick={() => navigate('/dashboard')}>
                  LOCAL CONTROL PLANE
                </button>
              </Breadcrumb.Item>
              <Breadcrumb.Item>{activeNavigationItem.label}</Breadcrumb.Item>
            </Breadcrumb>
          </Space>
          <Space size={16}>
            <Badge
              status={snapshot?.sync.offline ? 'warning' : 'success'}
              text={snapshot?.sync.offline ? 'OFFLINE' : `REV ${snapshot?.sync.revision ?? '—'}`}
            >
              <span />
            </Badge>
            <Button
              aria-label="Refresh agent"
              icon={<IconRefresh />}
              shape="circle"
              type="text"
              loading={refreshing}
              onClick={() => void refresh()}
            />
            <button className="identity-button" type="button" onClick={() => void logout()} title="Sign out">
              <Avatar size={30}>{avatarText}</Avatar>
              <span>
                {displayName}
                <small>{currentUser?.platformRoles[0]?.replace('_', ' ') ?? 'signed in'}</small>
              </span>
            </button>
          </Space>
        </Header>
        <Content className="desktop-content">
          <div className="content-grid">{children}</div>
        </Content>
      </Layout>
    </Layout>
  );
}
