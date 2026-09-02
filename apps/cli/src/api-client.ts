import { CliError, SecretRedactor, isRecord } from './safety.js';

export type FetchLike = typeof fetch;

export class ApiHttpError extends CliError {
  constructor(
    readonly status: number,
    message: string,
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
    const headers = new Headers({ accept: 'application/json' });
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
      throw new CliError(`API request failed: ${this.redactor.clean(error)}`);
    }

    const payload = await readJson(response);
    if (!response.ok) {
      const detail = problemMessage(payload);
      throw new ApiHttpError(
        response.status,
        this.redactor.clean(`API request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`),
      );
    }
    if (!isRecord(payload) || !Object.hasOwn(payload, 'data')) {
      throw new CliError('API returned an invalid success envelope.');
    }
    return payload.data as T;
  }

  async upload(
    target: UploadTarget,
    bytes: Uint8Array,
    label: 'artifact' | 'SBOM',
  ): Promise<string | undefined> {
    const headers = new Headers(target.headers);
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
      throw new CliError(`${label} upload failed: ${this.redactor.clean(error)}`);
    }
    if (!response.ok)
      throw new ApiHttpError(response.status, `${label} upload failed with HTTP ${response.status}.`);
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
    throw new CliError('API base URL must be an absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new CliError(
      'API base URL must be an HTTP(S) origin or path without credentials, query, or fragment.',
    );
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

function problemMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  for (const key of ['detail', 'message', 'title', 'code']) {
    const value = payload[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function trimApiPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new CliError('API paths must be same-origin absolute paths.');
  }
  return path.slice(1);
}
