import { describe, expect, it, vi } from 'vitest';

import type { CatalogEntry } from '../types/catalog';
import { createHostEventBus } from './eventBus';
import { createScopedHostApi, createScopedHostApiBinding, serveHostApi, type HostServices } from './hostApi';

describe('localized Host API context', () => {
  it('exposes the current locale snapshot to a context-capable micro-app', async () => {
    const locale = {
      direction: 'ltr' as const,
      fallbackLocales: ['en-US' as const],
      locale: 'zh-CN' as const,
      timeZone: 'Asia/Shanghai',
    };
    const host = createScopedHostApi(
      {
        manifest: { capabilities: ['context.read'], runtime: 'iframe' },
      } as unknown as CatalogEntry,
      {
        catalog: async () => [],
        events: createHostEventBus(),
        locale: () => locale,
        navigate: vi.fn(),
        notify: vi.fn(),
        route: () => ({ hash: '', pathname: '/', search: '' }),
        theme: () => ({ preference: 'system', resolved: 'light' }),
        user: () => ({
          displayName: 'Test user',
          email: 'test@example.com',
          id: '00000000-0000-4000-8000-000000000001',
          platformRoles: [],
        }),
        workspace: () => ({
          id: '00000000-0000-4000-8000-000000000010',
          name: 'Test',
          role: 'owner',
          slug: 'test',
        }),
      },
    );

    await expect(host.locale.getCurrent()).resolves.toEqual(locale);
  });

  it('keeps one Host API identity while locale and theme getters move to the latest snapshot', async () => {
    const events = createHostEventBus();
    const initialLocale: ReturnType<HostServices['locale']> = {
      direction: 'ltr',
      fallbackLocales: [],
      locale: 'en-US',
      timeZone: 'UTC',
    };
    const nextLocale: ReturnType<HostServices['locale']> = {
      direction: 'ltr',
      fallbackLocales: ['en-US'],
      locale: 'zh-CN',
      timeZone: 'Asia/Shanghai',
    };
    const initialServices = hostServices(events, initialLocale, 'light');
    const binding = createScopedHostApiBinding(contextEntry(), initialServices);
    const mountedHost = binding.host;
    const receivedLocales: (typeof nextLocale)[] = [];
    const unsubscribe = mountedHost.events.on('locale.changed', (locale) => {
      receivedLocales.push(locale as typeof nextLocale);
    });

    binding.update(hostServices(events, nextLocale, 'dark'));
    events.emit('locale.changed', nextLocale);

    expect(binding.host).toBe(mountedHost);
    await expect(mountedHost.locale.getCurrent()).resolves.toEqual(nextLocale);
    await expect(mountedHost.theme.getCurrent()).resolves.toEqual({
      preference: 'system',
      resolved: 'dark',
    });
    expect(receivedLocales).toEqual([nextLocale]);
    unsubscribe();
  });

  it('keeps an existing MessagePort subscribed when the binding context changes locale', async () => {
    const events = createHostEventBus();
    const english: ReturnType<HostServices['locale']> = {
      direction: 'ltr',
      fallbackLocales: [],
      locale: 'en-US',
      timeZone: 'UTC',
    };
    const chinese: ReturnType<HostServices['locale']> = {
      direction: 'ltr',
      fallbackLocales: ['en-US'],
      locale: 'zh-CN',
      timeZone: 'Asia/Shanghai',
    };
    const binding = createScopedHostApiBinding(contextEntry(), hostServices(events, english, 'light'));
    const channel = new MessageChannel();
    const closeHostPort = serveHostApi(channel.port1, binding.host);

    binding.update(hostServices(events, chinese, 'dark'));
    const localeEvent = nextPortMessage(channel.port2);
    events.emit('locale.changed', chinese);
    await expect(localeEvent).resolves.toEqual({
      event: 'locale.changed',
      kind: 'event',
      payload: chinese,
    });

    const localeResponse = nextPortMessage(channel.port2);
    channel.port2.postMessage({ id: 'locale-after-change', kind: 'request', method: 'locale.getCurrent' });
    await expect(localeResponse).resolves.toEqual({
      id: 'locale-after-change',
      kind: 'response',
      result: chinese,
    });

    const themeEvent = nextPortMessage(channel.port2);
    events.emit('theme.changed', { preference: 'system', resolved: 'dark' });
    await expect(themeEvent).resolves.toEqual({
      event: 'theme.changed',
      kind: 'event',
      payload: { preference: 'system', resolved: 'dark' },
    });

    closeHostPort();
    channel.port2.close();
  });
});

function nextPortMessage(port: MessagePort): Promise<unknown> {
  return new Promise((resolve) => {
    port.addEventListener('message', (event) => resolve(event.data), { once: true });
    port.start();
  });
}

function contextEntry(): CatalogEntry {
  return {
    applicationId: '00000000-0000-4000-8000-000000000101',
    releaseId: '00000000-0000-4000-8000-000000000201',
    manifest: { capabilities: ['context.read'], runtime: 'iframe' },
  } as unknown as CatalogEntry;
}

function hostServices(
  events: ReturnType<typeof createHostEventBus>,
  locale: ReturnType<HostServices['locale']>,
  resolved: 'dark' | 'light',
): HostServices {
  return {
    catalog: async () => [],
    events,
    locale: () => locale,
    navigate: vi.fn(),
    notify: vi.fn(),
    route: () => ({ hash: '', pathname: '/', search: '' }),
    theme: () => ({ preference: 'system', resolved }),
    user: () => ({
      displayName: 'Test user',
      email: 'test@example.com',
      id: '00000000-0000-4000-8000-000000000001',
      platformRoles: [],
    }),
    workspace: () => ({
      id: '00000000-0000-4000-8000-000000000010',
      name: 'Test',
      role: 'owner',
      slug: 'test',
    }),
  };
}
