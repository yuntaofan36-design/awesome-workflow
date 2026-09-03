import { useShellStore } from '../stores/shellStore';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  headers.set('accept-language', useShellStore.getState().localeSnapshot.locale);
  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: 'include',
    headers,
  });
  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const errorBody = isRecord(body) ? body : {};
    const message =
      (typeof errorBody.detail === 'string' && errorBody.detail) ||
      (typeof errorBody.title === 'string' && errorBody.title) ||
      (typeof errorBody.message === 'string' && errorBody.message) ||
      `Request failed (${response.status})`;
    throw new ApiError(
      message,
      response.status,
      typeof errorBody.code === 'string'
        ? errorBody.code
        : typeof errorBody.type === 'string'
          ? errorBody.type
          : undefined,
    );
  }
  return body as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
