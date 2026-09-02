import { ConfigProvider } from '@arco-design/web-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { HostApi, MicroAppModule } from '@awesome-workflow/web-sdk';

import { ControlPlaneApp } from './ControlPlaneApp';
import './arco-isolated.less';
import './styles.css';

type MountRecord = { cleanup: () => void; mountRoot: HTMLElement; root: Root };
const mounts = new WeakMap<HTMLElement, MountRecord>();

export async function mount(container: HTMLElement, host: HostApi): Promise<() => void> {
  unmount(container);
  const initialPath = await resolveInitialPath(host);
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
  root.render(
    <StrictMode>
      <ConfigProvider prefixCls="awcp" getPopupContainer={() => portalRoot}>
        <QueryClientProvider client={queryClient}>
          <ControlPlaneApp host={host} initialPath={initialPath} />
        </QueryClientProvider>
      </ConfigProvider>
    </StrictMode>,
  );
  const cleanup = () => queryClient.clear();
  mounts.set(container, { cleanup, mountRoot, root });
  return () => unmount(container);
}

export function unmount(container: HTMLElement): void {
  const record = mounts.get(container);
  if (!record) return;
  record.cleanup();
  record.root.unmount();
  record.mountRoot.remove();
  mounts.delete(container);
}

const remoteModule = { mount, unmount } satisfies MicroAppModule;
export default remoteModule;

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
