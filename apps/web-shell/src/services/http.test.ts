import { afterEach, describe, expect, it, vi } from 'vitest';

import { useShellStore } from '../stores/shellStore';
import { apiRequest } from './http';

afterEach(() => {
  vi.unstubAllGlobals();
  useShellStore.getState().setLocalePreference('system');
});

describe('platform API locale', () => {
  it('uses the active Shell locale and does not allow a stale caller header to override it', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('accept-language')).toBe('zh-CN');
      return new Response(JSON.stringify({ data: {} }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    useShellStore.getState().setLocalePreference('zh-CN');

    await apiRequest('/auth/session', { headers: { 'accept-language': 'en-US' } });

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
