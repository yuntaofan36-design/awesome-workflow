import {
  DESKTOP_RPC_PROTOCOL_VERSION,
  DesktopClient,
  DesktopRpcError,
  type DesktopRpcEnvelope,
  type DesktopRpcResponse,
  type DesktopRpcTransport,
  type DesktopTaskContext,
} from './core.js';

export * from './core.js';

export const WEB_UI_RPC_PATH = '/__awesome_workflow/rpc' as const;

const WEB_UI_FRAGMENT_PREFIX = '#aw-task=';
const MAX_BOOTSTRAP_CHARACTERS = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type WebUiLocationLike = Pick<Location, 'hash' | 'origin' | 'pathname' | 'search'>;
export type WebUiHistoryLike = Pick<History, 'state' | 'replaceState'>;
export type WebUiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CreateWebUiClientOptions = {
  location?: WebUiLocationLike;
  history?: WebUiHistoryLike;
  fetch?: WebUiFetch;
};

/**
 * Consumes the one-time task bootstrap from the URL fragment. The fragment is
 * removed before parsing so malformed data cannot leave a bearer lease in
 * browser history or in a copied URL.
 */
export function consumeWebUiTaskContext(
  location: WebUiLocationLike = globalThis.location,
  history: WebUiHistoryLike = globalThis.history,
): DesktopTaskContext {
  const fragment = location.hash;
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);

  assertLoopbackOrigin(location.origin);
  if (!fragment.startsWith(WEB_UI_FRAGMENT_PREFIX)) {
    throw new DesktopRpcError('Web UI task bootstrap is missing');
  }
  const encoded = fragment.slice(WEB_UI_FRAGMENT_PREFIX.length);
  if (
    encoded.length === 0 ||
    encoded.length > MAX_BOOTSTRAP_CHARACTERS ||
    encoded.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw new DesktopRpcError('Web UI task bootstrap is malformed');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeBase64Url(encoded)) as unknown;
  } catch {
    throw new DesktopRpcError('Web UI task bootstrap is malformed');
  }
  if (!isRecord(decoded)) {
    throw new DesktopRpcError('Web UI task bootstrap is malformed');
  }
  const expectedKeys = [
    'protocolVersion',
    'appId',
    'taskId',
    'lease',
    'rpcEndpoint',
    'workDirectory',
    'locale',
    'fallbackLocales',
  ];
  const keys = Object.keys(decoded);
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) {
    throw new DesktopRpcError('Web UI task bootstrap is malformed');
  }

  const { protocolVersion, appId, taskId, lease, rpcEndpoint, workDirectory, locale, fallbackLocales } =
    decoded;
  if (
    protocolVersion !== DESKTOP_RPC_PROTOCOL_VERSION ||
    !isBoundedString(appId, 3, 64) ||
    !/^[a-z][a-z0-9-]*$/.test(appId) ||
    !isBoundedString(taskId, 1, 128) ||
    !isBoundedString(lease, 32, 512) ||
    rpcEndpoint !== WEB_UI_RPC_PATH ||
    !isBoundedString(workDirectory, 1, 4096) ||
    (locale !== 'en-US' && locale !== 'zh-CN') ||
    !Array.isArray(fallbackLocales) ||
    fallbackLocales.some((value) => value !== 'en-US' && value !== 'zh-CN')
  ) {
    throw new DesktopRpcError('Web UI task bootstrap is incompatible');
  }

  return {
    protocolVersion,
    appId,
    taskId,
    lease,
    rpcEndpoint,
    workDirectory,
    locale,
    fallbackLocales,
  };
}

/** Same-origin HTTP transport for Agent-hosted Web UI applets. */
export class BrowserSameOriginRpcTransport implements DesktopRpcTransport {
  private readonly origin: string;

  constructor(
    origin: string = globalThis.location.origin,
    private readonly fetchImpl: WebUiFetch = globalThis.fetch.bind(globalThis),
    private readonly maxResponseBytes = MAX_RESPONSE_BYTES,
  ) {
    this.origin = assertLoopbackOrigin(origin);
  }

  async request<TResult>(endpoint: string, envelope: DesktopRpcEnvelope): Promise<TResult> {
    if (endpoint !== WEB_UI_RPC_PATH) {
      throw new DesktopRpcError('Web UI RPC endpoint is outside the managed task origin');
    }
    const target = new URL(endpoint, `${this.origin}/`);
    if (
      target.origin !== this.origin ||
      target.pathname !== WEB_UI_RPC_PATH ||
      target.search !== '' ||
      target.hash !== ''
    ) {
      throw new DesktopRpcError('Web UI RPC endpoint is outside the managed task origin');
    }

    const response = await this.fetchImpl(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      cache: 'no-store',
      credentials: 'omit',
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    if (response.url) {
      const responseUrl = new URL(response.url);
      if (responseUrl.origin !== this.origin || responseUrl.pathname !== WEB_UI_RPC_PATH) {
        throw new DesktopRpcError('Web UI RPC response escaped the managed task origin');
      }
    }
    if (!response.ok) {
      throw new DesktopRpcError(`Agent Web UI RPC rejected the request with HTTP ${response.status}`);
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
    if (contentType !== 'application/json') {
      throw new DesktopRpcError('Agent Web UI RPC returned an unexpected content type');
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
      throw new DesktopRpcError('Agent Web UI RPC response exceeded the size limit');
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > this.maxResponseBytes) {
      throw new DesktopRpcError('Agent Web UI RPC response exceeded the size limit');
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      throw new DesktopRpcError('Agent Web UI RPC returned malformed JSON');
    }
    if (!isRpcResponse<TResult>(decoded)) {
      throw new DesktopRpcError('Agent Web UI RPC returned a malformed response');
    }
    if (decoded.protocolVersion !== DESKTOP_RPC_PROTOCOL_VERSION) {
      throw new DesktopRpcError('Agent task RPC protocol version mismatch');
    }
    if (!decoded.ok) {
      throw new DesktopRpcError(decoded.error || 'Agent task RPC request was rejected');
    }
    return decoded.data as TResult;
  }
}

export function createWebUiClient(options: CreateWebUiClientOptions = {}): DesktopClient {
  const location = options.location ?? globalThis.location;
  const history = options.history ?? globalThis.history;
  const context = consumeWebUiTaskContext(location, history);
  return new DesktopClient(
    new BrowserSameOriginRpcTransport(location.origin, options.fetch ?? globalThis.fetch.bind(globalThis)),
    context,
  );
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = globalThis.atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function assertLoopbackOrigin(value: string): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new DesktopRpcError('Web UI task origin is invalid');
  }
  const port = Number(origin.port);
  if (
    origin.origin !== value ||
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    !origin.port ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    origin.username !== '' ||
    origin.password !== ''
  ) {
    throw new DesktopRpcError('Web UI task origin must be an Agent loopback origin');
  }
  return origin.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function isRpcResponse<TResult>(value: unknown): value is DesktopRpcResponse<TResult> {
  if (!isRecord(value) || typeof value.protocolVersion !== 'number' || typeof value.ok !== 'boolean') {
    return false;
  }
  if ('error' in value && value.error !== undefined && typeof value.error !== 'string') {
    return false;
  }
  return true;
}
