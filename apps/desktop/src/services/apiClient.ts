import { invoke } from '@tauri-apps/api/core';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

type BrokerResponse = {
  status: number;
  body: unknown;
};

/**
 * Authenticated desktop requests cross the Rust broker. The WebView never owns
 * a bearer token, custom Authorization header, or caller-selected API origin.
 */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if ((init.method ?? 'GET').toUpperCase() !== 'GET' || init.body || init.headers) {
    throw new ApiError('This desktop API endpoint is not allowed.', 400, 'endpoint_not_allowed');
  }
  if (!('__TAURI_INTERNALS__' in window)) {
    throw new ApiError('Authenticated API access requires the desktop host.', 503, 'desktop_required');
  }
  const response = await invoke<BrokerResponse>('desktop_api_request', {
    input: { method: 'GET', path },
  });
  const body = response.body;
  if (response.status < 200 || response.status >= 300) {
    const error = body as { code?: string; message?: string } | undefined;
    throw new ApiError(
      error?.message || `Request failed with ${response.status}`,
      response.status,
      error?.code,
    );
  }
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}
