import { invoke } from '@tauri-apps/api/core';

import { getDesktopRequestLocale } from '../i18n/requestLocale';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly diagnostic?: string,
  ) {
    super(code);
  }
}

type BrokerResponse = {
  status: number;
  body: unknown;
};

export type DesktopApiRequestInit = {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
};

/**
 * Authenticated desktop requests cross the Rust broker. The WebView never owns
 * a bearer token, custom Authorization header, or caller-selected API origin.
 */
export async function apiRequest<T>(path: string, init: DesktopApiRequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  if (!('__TAURI_INTERNALS__' in window)) {
    throw new ApiError('desktop_required', 503);
  }
  const response = await invoke<BrokerResponse>('desktop_api_request', {
    input: {
      method,
      path,
      locale: getDesktopRequestLocale(),
      ...(init.body === undefined ? {} : { body: init.body }),
    },
  });
  const body = response.body;
  if (response.status < 200 || response.status >= 300) {
    const error = body as { code?: string; detail?: string; message?: string } | undefined;
    throw new ApiError(error?.code || 'request_failed', response.status, error?.detail || error?.message);
  }
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}
