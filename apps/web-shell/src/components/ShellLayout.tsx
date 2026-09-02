import { Alert, Avatar, Button, Dropdown, Menu, Select, Spin, Tooltip } from '@arco-design/web-react';
import {
  IconApps,
  IconBulb,
  IconDashboard,
  IconLeft,
  IconMenuFold,
  IconMenuUnfold,
  IconMoon,
  IconPoweroff,
  IconSafe,
  IconSun,
} from '@arco-design/web-react/icon';
import { PlatformMark, SignalBadge } from '@awesome-workflow/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import { getCatalog } from '../services/catalog';
import { getWorkspaces } from '../services/workspaces';
import { createHostEventBus, type HostEventBus } from '../runtime/eventBus';
import {
  selectCollapsed,
  selectResolvedTheme,
  selectSetCollapsed,
  selectSetThemePreference,
  selectSetWorkspace,
  selectThemePreference,
  selectWorkspace,
  useShellStore,
} from '../stores/shellStore';
import { selectSignOut, selectUser, useUserStore } from '../stores/userStore';
import type { CatalogEntry } from '../types/catalog';
import { AppRuntimePage } from '../pages/AppRuntimePage';
import { DashboardPage } from '../pages/DashboardPage';
import { SecurityPage } from '../pages/SecurityPage';

export type ShellOutletContext = {
  catalog: CatalogEntry[];
  catalogError: Error | null;
  catalogPending: boolean;
  events: HostEventBus;
  refreshCatalog: () => Promise<unknown>;
};

export function ShellLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useUserStore(selectUser);
  const signOut = useUserStore(selectSignOut);
  const collapsed = useShellStore(selectCollapsed);
  const setCollapsed = useShellStore(selectSetCollapsed);
  const workspace = useShellStore(selectWorkspace);
  const setWorkspace = useShellStore(selectSetWorkspace);
  const themePreference = useShellStore(selectThemePreference);
  const resolvedTheme = useShellStore(selectResolvedTheme);
  const setThemePreference = useShellStore(selectSetThemePreference);
  const events = useMemo(() => createHostEventBus(), []);
  const workspacesQuery = useQuery({ queryKey: ['workspaces'], queryFn: getWorkspaces, staleTime: 60_000 });
  const catalogQuery = useQuery({
    enabled: Boolean(workspace),
    queryKey: ['catalog', workspace?.id ?? 'unselected', 'stable'],
    queryFn: () => getCatalog(assertWorkspace(workspace).id, 'stable'),
  });

  useEffect(() => {
    const visible = workspacesQuery.data;
    if (!visible?.length) return;
    if (workspace && visible.some((candidate) => candidate.id === workspace.id)) return;
    const preferredId = import.meta.env.DEV ? import.meta.env.VITE_WORKSPACE_ID : undefined;
    setWorkspace(visible.find((candidate) => candidate.id === preferredId) ?? visible[0]!);
  }, [setWorkspace, workspace, workspacesQuery.data]);

  useEffect(() => {
    document.documentElement.dataset.awTheme = resolvedTheme;
    events.emit('theme.changed', { preference: themePreference, resolved: resolvedTheme });
  }, [events, resolvedTheme, themePreference]);

  useEffect(() => {
    events.emit('route.changed', {
      hash: location.hash,
      pathname: location.pathname,
      search: location.search,
    });
  }, [events, location.hash, location.pathname, location.search]);

  useEffect(() => {
    if (workspace) events.emit('workspace.changed', workspace);
  }, [events, workspace]);

  if (workspacesQuery.isPending || (!workspace && workspacesQuery.data?.length)) {
    return (
      <div className="auth-boot">
        <span>AW / WORKSPACE SCOPE</span>
        <Spin dot tip="Loading accessible workspaces…" />
      </div>
    );
  }
  if (workspacesQuery.isError) {
    return (
      <div className="auth-boot">
        <Alert type="error" title="Workspace scope unavailable" content={workspacesQuery.error.message} />
        <Button onClick={() => void workspacesQuery.refetch()}>Retry</Button>
      </div>
    );
  }
  if (!workspace) {
    return (
      <div className="auth-boot">
        <Alert
          type="warning"
          title="No accessible workspace"
          content="Ask a workspace owner to grant membership."
        />
      </div>
    );
  }

  const context: ShellOutletContext = {
    catalog: catalogQuery.data ?? [],
    catalogError: catalogQuery.error,
    catalogPending: catalogQuery.isPending,
    events,
    refreshCatalog: () => catalogQuery.refetch(),
  };

  return (
    <div className="shell-root" data-aw-theme={resolvedTheme}>
      <aside className="shell-sidebar" data-collapsed={collapsed || undefined}>
        <div className="shell-brand">
          <PlatformMark compact={collapsed} />
        </div>
        <nav className="shell-nav" aria-label="Primary navigation">
          <ShellNavItem collapsed={collapsed} icon={<IconDashboard />} label="Overview" to="/" />
          <div className="shell-nav__section">{collapsed ? '•••' : 'MICRO APPLICATIONS'}</div>
          {catalogQuery.isPending ? (
            <Spin className="shell-nav__spin" dot />
          ) : (
            (catalogQuery.data ?? []).map((entry) => (
              <ShellNavItem
                collapsed={collapsed}
                icon={<RuntimeGlyph runtime={entry.manifest.runtime} />}
                key={entry.applicationId}
                label={entry.name}
                to={`/apps/${entry.slug}`}
              />
            ))
          )}
          <div className="shell-nav__section">{collapsed ? '•••' : 'SYSTEM'}</div>
          <ShellNavItem collapsed={collapsed} icon={<IconSafe />} label="Identity & access" to="/security" />
        </nav>
        <Button
          className="shell-collapse"
          type="text"
          icon={collapsed ? <IconMenuUnfold /> : <IconMenuFold />}
          onClick={() => setCollapsed(!collapsed)}
        >
          {!collapsed && 'Collapse rail'}
        </Button>
      </aside>

      <div className="shell-stage">
        <header className="shell-topbar">
          <div className="shell-route-meta">
            <span>AW / {workspace.slug.toUpperCase()}</span>
            <strong>{resolveRouteTitle(location.pathname, context.catalog)}</strong>
          </div>
          <div className="shell-topbar__actions">
            <Select
              className="workspace-select"
              value={workspace.id}
              onChange={(id) => {
                const selected = workspacesQuery.data?.find((candidate) => candidate.id === id);
                if (selected) setWorkspace(selected);
              }}
              options={(workspacesQuery.data ?? []).map((candidate) => ({
                label: `${candidate.name} · ${candidate.role}`,
                value: candidate.id,
              }))}
            />
            <SignalBadge
              tone={catalogQuery.isError ? 'danger' : catalogQuery.isFetching ? 'warning' : 'success'}
            >
              {catalogQuery.isError
                ? 'catalog fault'
                : catalogQuery.isFetching
                  ? 'synchronizing'
                  : 'control online'}
            </SignalBadge>
            <Tooltip content={`Theme: ${themePreference}`}>
              <Button
                shape="circle"
                type="text"
                icon={resolvedTheme === 'dark' ? <IconMoon /> : <IconSun />}
                onClick={() => setThemePreference(resolvedTheme === 'dark' ? 'light' : 'dark')}
              />
            </Tooltip>
            <Dropdown
              droplist={
                <Menu>
                  <Menu.Item key="security" onClick={() => navigate('/security')}>
                    <IconSafe /> Identity & access
                  </Menu.Item>
                  <Menu.Item key="logout" onClick={() => void signOut()}>
                    <IconPoweroff /> Sign out
                  </Menu.Item>
                </Menu>
              }
              trigger="click"
            >
              <button className="shell-user" type="button">
                <Avatar size={30}>{user?.displayName.slice(0, 1).toUpperCase()}</Avatar>
                <span>
                  <strong>{user?.displayName}</strong>
                  <small>{workspace.role}</small>
                </span>
              </button>
            </Dropdown>
          </div>
        </header>

        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route index element={<DashboardPage />} />
            <Route path="apps/:slug/*" element={<AppRuntimePage />} />
            <Route path="security" element={<SecurityPage />} />
            <Route path="404" element={<NotFoundPage />} />
            <Route path="*" element={<Navigate replace to="/404" />} />
          </Route>
        </Routes>
      </div>
    </div>
  );
}

function ShellNavItem({
  collapsed,
  icon,
  label,
  to,
}: {
  collapsed: boolean;
  icon: React.ReactNode;
  label: string;
  to: string;
}) {
  const item = (
    <NavLink
      className={({ isActive }) => `shell-nav__item${isActive ? ' is-active' : ''}`}
      end={to === '/'}
      to={to}
    >
      <span className="shell-nav__icon">{icon}</span>
      {!collapsed && <span>{label}</span>}
    </NavLink>
  );
  return collapsed ? (
    <Tooltip content={label} position="right">
      {item}
    </Tooltip>
  ) : (
    item
  );
}

function RuntimeGlyph({ runtime }: { runtime: CatalogEntry['manifest']['runtime'] }) {
  if (runtime === 'federation') return <IconApps />;
  if (runtime === 'iframe') return <IconBulb />;
  return <IconLeft />;
}

function resolveRouteTitle(pathname: string, catalog: CatalogEntry[]): string {
  if (pathname === '/') return 'Overview';
  if (pathname.startsWith('/security')) return 'Identity & access';
  const slug = pathname.match(/^\/apps\/([^/]+)/)?.[1];
  return catalog.find((entry) => entry.slug === slug)?.name ?? 'Unknown route';
}

function NotFoundPage() {
  return (
    <div className="shell-not-found">
      <span>404 / ROUTE DRIFT</span>
      <h1>This path is outside the workspace map.</h1>
      <Button href="/">Return to overview</Button>
    </div>
  );
}

function assertWorkspace<T>(workspace: T | null): T {
  if (!workspace) throw new Error('Workspace is not selected');
  return workspace;
}
