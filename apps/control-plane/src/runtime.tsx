import { ConfigProvider } from '@arco-design/web-react';
import arcoEnUS from '@arco-design/web-react/es/locale/en-US';
import arcoZhCN from '@arco-design/web-react/es/locale/zh-CN';
import type { LocaleSnapshot } from '@awesome-workflow/contracts';
import { createLocaleSnapshot } from '@awesome-workflow/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { HostApi } from '@awesome-workflow/web-sdk';

import { ControlPlaneApp } from './ControlPlaneApp';
import { LocalizedControlPlaneErrorBoundary } from './components/ControlPlaneErrorBoundary';
import { applyControlPlaneDocumentLocale, ControlPlaneI18nProvider, createControlPlaneI18n } from './i18n';
import { getStandaloneLocaleControls } from './standaloneHost';
import './arco-isolated.less';
import './styles.css';

type MountRecord = { cleanup: () => void; mountRoot: HTMLElement; root: Root };
const mounts = new WeakMap<HTMLElement, MountRecord>();

export async function mountControlPlane(container: HTMLElement, host: HostApi): Promise<() => void> {
  unmountControlPlane(container);
  const [initialPath, initialLocale] = await Promise.all([
    resolveInitialPath(host),
    resolveInitialLocale(host),
  ]);
  const i18n = await createControlPlaneI18n(initialLocale.locale);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 20_000 },
    },
  });
  const mountRoot = document.createElement('div');
  mountRoot.className = 'awcp-mount-root';
  const surface = document.createElement('div');
  surface.className = 'awcp-react-surface';
  const portalRoot = document.createElement('div');
  portalRoot.className = 'awcp-portal-root';
  mountRoot.append(surface, portalRoot);
  container.replaceChildren(mountRoot);
  const root = createRoot(surface);
  const previousTitle = document.title;
  const standaloneLocale = getStandaloneLocaleControls(host);
  const ownsDocumentTitle = standaloneLocale !== undefined;
  let currentLocale = initialLocale;
  let disposed = false;
  let appliedTitle = '';

  const render = () => {
    applyControlPlaneDocumentLocale(i18n, currentLocale, document, {
      ownsTitle: ownsDocumentTitle,
    });
    if (ownsDocumentTitle) appliedTitle = document.title;
    root.render(
      <StrictMode>
        <ControlPlaneI18nProvider value={{ instance: i18n, locale: currentLocale, standaloneLocale }}>
          <LocalizedControlPlaneErrorBoundary>
            <ConfigProvider
              prefixCls="awcp"
              getPopupContainer={() => portalRoot}
              locale={currentLocale.locale === 'zh-CN' ? arcoZhCN : arcoEnUS}
            >
              <QueryClientProvider client={queryClient}>
                <ControlPlaneApp host={host} initialPath={initialPath} />
              </QueryClientProvider>
            </ConfigProvider>
          </LocalizedControlPlaneErrorBoundary>
        </ControlPlaneI18nProvider>
      </StrictMode>,
    );
  };
  const unsubscribeLocale = host.events.on('locale.changed', (nextLocale) => {
    void (async () => {
      await i18n.changeLanguage(nextLocale.locale);
      if (disposed) return;
      currentLocale = nextLocale;
      render();
    })();
  });
  render();

  const cleanup = () => {
    disposed = true;
    unsubscribeLocale();
    queryClient.clear();
    if (ownsDocumentTitle && document.title === appliedTitle) document.title = previousTitle;
  };
  mounts.set(container, { cleanup, mountRoot, root });
  return () => unmountControlPlane(container);
}

export function unmountControlPlane(container: HTMLElement): void {
  const record = mounts.get(container);
  if (!record) return;
  record.cleanup();
  record.root.unmount();
  record.mountRoot.remove();
  mounts.delete(container);
}

async function resolveInitialPath(host: HostApi): Promise<string> {
  try {
    const { pathname } = await host.route.getCurrent();
    return (
      ['/applications', '/releases', '/channels', '/approvals'].find((candidate) =>
        pathname.endsWith(candidate),
      ) ?? '/applications'
    );
  } catch {
    return '/applications';
  }
}

async function resolveInitialLocale(host: HostApi): Promise<LocaleSnapshot> {
  try {
    return await host.locale.getCurrent();
  } catch {
    return createLocaleSnapshot('en-US', {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    });
  }
}
