import { Button, Message, Skeleton } from '@arco-design/web-react';
import { IconRefresh } from '@arco-design/web-react/icon';
import { SignalBadge, StatePanel } from '@awesome-workflow/ui';
import { useRef } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';

import '@arco-design/web-react/es/Message/style/css.js';
import '@arco-design/web-react/es/Skeleton/style/css.js';

import type { ShellOutletContext } from '../components/ShellLayout';
import { LocalizedErrorAlert } from '../components/LocalizedErrorAlert';
import { useI18n } from '../i18n/I18nProvider';
import { getCatalog } from '../services/catalog';
import { createScopedHostApiBinding, type HostServices, type ScopedHostApiBinding } from '../runtime/hostApi';
import { runtimeScopeKey } from '../runtime/lifecycle';
import { RuntimeSurface } from '../runtime/RuntimeSurface';
import {
  selectResolvedTheme,
  selectLocaleSnapshot,
  selectThemePreference,
  selectWorkspace,
  useShellStore,
} from '../stores/shellStore';
import { selectUser, useUserStore } from '../stores/userStore';

export function AppRuntimePage() {
  const { t } = useI18n();
  const { slug } = useParams();
  const navigate = useNavigate();
  const { catalog, catalogError, catalogPending, events, refreshCatalog } =
    useOutletContext<ShellOutletContext>();
  const user = useUserStore(selectUser);
  const workspace = useShellStore(selectWorkspace);
  const themePreference = useShellStore(selectThemePreference);
  const resolvedTheme = useShellStore(selectResolvedTheme);
  const localeSnapshot = useShellStore(selectLocaleSnapshot);
  const entry = catalog.find((candidate) => candidate.slug === slug);
  const hostBindingRef = useRef<{
    binding: ScopedHostApiBinding;
    events: HostServices['events'];
    scopeKey: string;
  } | null>(null);

  if (!entry || !user || !workspace) {
    hostBindingRef.current = null;
  } else {
    const services: HostServices = {
      catalog: (channel) => getCatalog(workspace.id, localeSnapshot, channel ?? 'stable'),
      events,
      locale: () => localeSnapshot,
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
    };
    const scopeKey = runtimeScopeKey(entry, user.id, workspace.id);
    if (hostBindingRef.current?.scopeKey !== scopeKey || hostBindingRef.current.events !== events) {
      hostBindingRef.current = {
        binding: createScopedHostApiBinding(entry, services),
        events,
        scopeKey,
      };
    } else {
      hostBindingRef.current.binding.update(services);
    }
  }
  const host = hostBindingRef.current?.binding.host ?? null;
  const runtimeKey = hostBindingRef.current?.scopeKey ?? null;

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
        <LocalizedErrorAlert error={catalogError} title={t('runtime.catalogUnavailable')} />
      </main>
    );
  }
  if (!entry || !host || !runtimeKey) {
    return (
      <main className="shell-page runtime-page">
        <StatePanel title={t('runtime.missingTitle')}>
          <p>{t('runtime.missingBody')}</p>
          <Button onClick={() => void refreshCatalog()}>{t('common.refreshCatalog')}</Button>
        </StatePanel>
      </main>
    );
  }

  return (
    <main className="runtime-page">
      <header className="runtime-header">
        <div>
          <span>{t('runtime.microApp', { runtime: t(`runtimeLabel.${entry.manifest.runtime}`) })}</span>
          <h1>{entry.name}</h1>
          <p>{entry.summary}</p>
        </div>
        <div className="runtime-header__meta">
          <SignalBadge tone={entry.manifest.runtime === 'federation' ? 'success' : 'neutral'}>
            {t(`runtimeLabel.${entry.manifest.runtime}`)}
          </SignalBadge>
          <code>{entry.version}</code>
          <Button
            type="text"
            shape="circle"
            aria-label={t('common.refreshCatalog')}
            icon={<IconRefresh />}
            onClick={() => void refreshCatalog()}
          />
        </div>
      </header>
      <RuntimeSurface entry={entry} host={host} key={runtimeKey} />
    </main>
  );
}
