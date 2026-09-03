import type { SupportedLocale } from '@awesome-workflow/contracts';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');

export type ApiProblem = {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  code?: string;
  errors?: unknown;
};

export class ApiProblemError extends Error {
  readonly code: string | undefined;

  constructor(
    readonly status: number,
    readonly problem: ApiProblem,
  ) {
    super(problem.detail || problem.title || `Request failed (${status})`);
    this.name = 'ApiProblemError';
    this.code = problem.code;
  }
}

export async function request<T>(path: string, init?: RequestInit, locale?: SupportedLocale): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('accept', 'application/json');
  if (locale) headers.set('accept-language', locale);
  if (init?.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });

  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) throw new ApiProblemError(response.status, parseProblem(body));
  return body as T;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseProblem(body: unknown): ApiProblem {
  if (!isRecord(body)) return {};
  return {
    ...(typeof body.type === 'string' ? { type: body.type } : {}),
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(typeof body.status === 'number' ? { status: body.status } : {}),
    ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
    ...(typeof body.instance === 'string' ? { instance: body.instance } : {}),
    ...(typeof body.code === 'string' ? { code: body.code } : {}),
    ...(Object.hasOwn(body, 'errors') ? { errors: body.errors } : {}),
  };
}
