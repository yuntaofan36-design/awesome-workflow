import { Alert, Button, Message, Skeleton } from '@arco-design/web-react';
import { IconRefresh } from '@arco-design/web-react/icon';
import { SignalBadge, StatePanel } from '@awesome-workflow/ui';
import { useMemo } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';

import type { ShellOutletContext } from '../components/ShellLayout';
import { getCatalog } from '../services/catalog';
import { createScopedHostApi } from '../runtime/hostApi';
import { RuntimeSurface } from '../runtime/RuntimeSurface';
import {
  selectResolvedTheme,
  selectThemePreference,
  selectWorkspace,
  useShellStore,
} from '../stores/shellStore';
import { selectUser, useUserStore } from '../stores/userStore';

export function AppRuntimePage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { catalog, catalogError, catalogPending, events, refreshCatalog } =
    useOutletContext<ShellOutletContext>();
  const user = useUserStore(selectUser);
  const workspace = useShellStore(selectWorkspace);
  const themePreference = useShellStore(selectThemePreference);
  const resolvedTheme = useShellStore(selectResolvedTheme);
  const entry = catalog.find((candidate) => candidate.slug === slug);

  const host = useMemo(
    () =>
      entry && user && workspace
        ? createScopedHostApi(entry, {
            catalog: (channel) => getCatalog(workspace.id, channel ?? 'stable'),
            events,
            navigate: (to, options) => navigate(to, { replace: options?.replace }),
            notify: (message, level) => {
              if (level === 'success') Message.success(message);
              else if (level === 'warning') Message.warning(message);
              else if (level === 'error') Message.error(message);
              else Message.info(message);
            },
            route: () => ({
              hash: window.location.hash,
              pathname: window.location.pathname,
              search: window.location.search,
            }),
            theme: () => ({ preference: themePreference, resolved: resolvedTheme }),
            user: () => user,
            workspace: () => workspace,
          })
        : null,
    [entry, events, navigate, resolvedTheme, themePreference, user, workspace],
  );

  if (catalogPending) {
    return (
      <main className="shell-page runtime-page">
        <Skeleton animation text={{ rows: 8 }} />
      </main>
    );
  }
  if (catalogError) {
    return (
      <main className="shell-page runtime-page">
        <Alert type="error" title="Catalog unavailable" content={catalogError.message} />
      </main>
    );
  }
  if (!entry || !host) {
    return (
      <main className="shell-page runtime-page">
        <StatePanel title="Application is not in this channel">
          <p>The route has no stable catalog entry for this workspace.</p>
          <Button onClick={() => void refreshCatalog()}>Refresh catalog</Button>
        </StatePanel>
      </main>
    );
  }

  return (
    <main className="runtime-page">
      <header className="runtime-header">
        <div>
          <span>MICRO-APP / {entry.manifest.runtime.toUpperCase()}</span>
          <h1>{entry.name}</h1>
          <p>{entry.summary}</p>
        </div>
        <div className="runtime-header__meta">
          <SignalBadge tone={entry.manifest.runtime === 'federation' ? 'success' : 'neutral'}>
            {entry.manifest.runtime}
          </SignalBadge>
          <code>{entry.version}</code>
          <Button type="text" shape="circle" icon={<IconRefresh />} onClick={() => void refreshCatalog()} />
        </div>
      </header>
      <RuntimeSurface entry={entry} host={host} key={entry.releaseId} />
    </main>
  );
}
