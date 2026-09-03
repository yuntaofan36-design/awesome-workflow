import { CliError, SecretRedactor, isRecord } from './safety.js';
import { cliText, getCliLocale, problemText } from './i18n.js';

export type FetchLike = typeof fetch;

export class ApiHttpError extends CliError {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

export class ApiClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly accessToken: string | undefined,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly redactor = new SecretRedactor(),
  ) {
    this.baseUrl = normalizeApiBase(baseUrl);
    this.redactor.add(accessToken);
  }

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers = new Headers({
      accept: 'application/json',
      'accept-language': getCliLocale(),
    });
    if (this.accessToken) headers.set('authorization', `Bearer ${this.accessToken}`);
    if (body !== undefined) headers.set('content-type', 'application/json');

    let response: Response;
    try {
      response = await this.fetchImpl(new URL(trimApiPath(path), `${this.baseUrl}/`), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new CliError(cliText('api.request', { detail: this.redactor.clean(error) }));
    }

    const payload = await readJson(response);
    if (!response.ok) {
      const problem = problemDescriptor(payload);
      const detail = problemText(problem.code ?? '', problem.message);
      throw new ApiHttpError(
        response.status,
        this.redactor.clean(
          cliText('api.http', { status: response.status, detail: detail ? `: ${detail}` : '' }),
        ),
        problem.code,
      );
    }
    if (!isRecord(payload) || !Object.hasOwn(payload, 'data')) {
      throw new CliError(cliText('api.envelope'));
    }
    return payload.data as T;
  }

  async upload(target: UploadTarget, bytes: Uint8Array, label: string): Promise<string | undefined> {
    const headers = new Headers(target.headers);
    // Presigned object-storage requests are a separate trust/audience boundary.
    // Locale negotiation belongs only on the Awesome Workflow platform API.
    headers.delete('accept-language');
    let response: Response;
    try {
      response = await this.fetchImpl(target.url, {
        method: 'PUT',
        headers,
        body: Buffer.from(bytes),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new CliError(cliText('upload.failed', { label, detail: this.redactor.clean(error) }));
    }
    if (!response.ok)
      throw new ApiHttpError(response.status, cliText('upload.http', { label, status: response.status }));
    return response.headers.get('etag') ?? undefined;
  }
}

export type UploadTarget = {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
};

export function normalizeApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(cliText('api.baseAbsolute'));
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new CliError(cliText('api.baseSafe'));
  }
  const cleanPath = url.pathname.replace(/\/+$/, '');
  url.pathname = cleanPath.endsWith('/api/v1') ? cleanPath : `${cleanPath}/api/v1`.replace(/\/{2,}/g, '/');
  return url.toString().replace(/\/$/, '');
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return { data: undefined };
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function problemDescriptor(payload: unknown): { code?: string; message?: string } {
  if (!isRecord(payload)) return {};
  const code = typeof payload.code === 'string' ? payload.code : undefined;
  for (const key of ['detail', 'message', 'title']) {
    const value = payload[key];
    if (typeof value === 'string' && value) return { code, message: value };
  }
  return { code };
}

function trimApiPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new CliError(cliText('api.path'));
  }
  return path.slice(1);
}
