import type { CurrentUser, ReleaseChannel, Workspace } from '@awesome-workflow/contracts';

export const AW_BRIDGE_VERSION = 1 as const;
export const AW_READY_MESSAGE = 'aw:bridge:ready' as const;
export const AW_CONNECT_MESSAGE = 'aw:bridge:connect' as const;

export type UserSummary = Pick<CurrentUser, 'displayName' | 'email' | 'id' | 'platformRoles'>;

export type WorkspaceSummary = Pick<Workspace, 'id' | 'name' | 'role' | 'slug'>;

export type ThemeSnapshot = {
  preference: 'dark' | 'light' | 'system';
  resolved: 'dark' | 'light';
};

export type RouteSnapshot = {
  hash: string;
  pathname: string;
  search: string;
};

export type CatalogItemSummary = {
  id: string;
  name: string;
  runtime: 'federation' | 'iframe' | 'link';
  slug: string;
  version: string | null;
};

export type NotificationBrokerRequest = {
  operation: 'notifications.show';
  payload: {
    level?: 'error' | 'info' | 'success' | 'warning';
    message: string;
  };
};

export type CatalogBrokerRequest = {
  operation: 'catalog.list';
  payload?: { channel?: ReleaseChannel };
};

export type BrokerRequest = CatalogBrokerRequest | NotificationBrokerRequest;

export type BrokerResult<TRequest extends BrokerRequest> = TRequest extends CatalogBrokerRequest
  ? readonly CatalogItemSummary[]
  : void;

export type HostEventMap = {
  'route.changed': RouteSnapshot;
  'theme.changed': ThemeSnapshot;
  'workspace.changed': WorkspaceSummary;
};

export type HostEventName = keyof HostEventMap;
export type Unsubscribe = () => void;

export type HostApi = {
  readonly version: typeof AW_BRIDGE_VERSION;
  readonly broker: {
    request: <TRequest extends BrokerRequest>(request: TRequest) => Promise<BrokerResult<TRequest>>;
  };
  readonly events: {
    on: <TEvent extends HostEventName>(
      event: TEvent,
      listener: (payload: HostEventMap[TEvent]) => void,
    ) => Unsubscribe;
  };
  readonly navigation: {
    navigate: (to: string, options?: { replace?: boolean }) => Promise<void>;
  };
  readonly route: {
    getCurrent: () => Promise<RouteSnapshot>;
  };
  readonly theme: {
    getCurrent: () => Promise<ThemeSnapshot>;
  };
  readonly user: {
    getSummary: () => Promise<UserSummary>;
  };
  readonly workspace: {
    getCurrent: () => Promise<WorkspaceSummary>;
  };
};

export type MicroAppMountResult = Unsubscribe | void;

export type MicroAppModule = {
  mount: (container: HTMLElement, host: HostApi) => MicroAppMountResult | Promise<MicroAppMountResult>;
  unmount: (container: HTMLElement) => Promise<void> | void;
};

export type BridgeMethod =
  | 'broker.request'
  | 'navigation.navigate'
  | 'route.getCurrent'
  | 'theme.getCurrent'
  | 'user.getSummary'
  | 'workspace.getCurrent';

export type BridgeReadyMessage = {
  type: typeof AW_READY_MESSAGE;
  version: typeof AW_BRIDGE_VERSION;
};

export type BridgeConnectMessage = {
  type: typeof AW_CONNECT_MESSAGE;
  version: typeof AW_BRIDGE_VERSION;
};

export type BridgeRequestEnvelope = {
  id: string;
  kind: 'request';
  method: BridgeMethod;
  params?: unknown;
};

export type BridgeResponseEnvelope = {
  error?: { code: string; message: string };
  id: string;
  kind: 'response';
  result?: unknown;
};

export type BridgeEventEnvelope<TEvent extends HostEventName = HostEventName> = {
  event: TEvent;
  kind: 'event';
  payload: HostEventMap[TEvent];
};

export type BridgeEnvelope = BridgeEventEnvelope | BridgeRequestEnvelope | BridgeResponseEnvelope;

export type ConnectToHostOptions = {
  requestTimeoutMs?: number;
  targetOrigin: string;
  timeoutMs?: number;
};

export function connectToHost(options: ConnectToHostOptions): Promise<HostApi> {
  const targetOrigin = normalizeTargetOrigin(options.targetOrigin);
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      window.removeEventListener('message', onConnect);
      reject(new Error('Awesome Workflow host bridge did not connect in time'));
    }, timeoutMs);

    function onConnect(event: MessageEvent<BridgeConnectMessage>) {
      if (!isExpectedConnectEvent(event, window.parent, targetOrigin)) {
        return;
      }

      const port = event.ports[0];
      if (!port) {
        return;
      }

      globalThis.clearTimeout(timer);
      window.removeEventListener('message', onConnect);
      resolve(createBridge(port, options.requestTimeoutMs ?? 10_000));
    }

    window.addEventListener('message', onConnect);
    window.parent.postMessage(
      { type: AW_READY_MESSAGE, version: AW_BRIDGE_VERSION } satisfies BridgeReadyMessage,
      targetOrigin,
    );
  });
}

export function normalizeTargetOrigin(value: string): string {
  if (!value || value === '*') {
    throw new Error('A fixed host targetOrigin is required');
  }

  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('The host targetOrigin must use HTTP(S)');
  }
  return url.origin;
}

export function isBridgeReadyMessage(value: unknown): value is BridgeReadyMessage {
  if (!isRecord(value)) return false;
  return value.type === AW_READY_MESSAGE && value.version === AW_BRIDGE_VERSION;
}

export function isBridgeRequestEnvelope(value: unknown): value is BridgeRequestEnvelope {
  if (!isRecord(value) || value.kind !== 'request' || typeof value.id !== 'string') return false;
  return BRIDGE_METHODS.has(value.method as BridgeMethod);
}

export function isExpectedConnectEvent(
  event: Pick<MessageEvent<BridgeConnectMessage>, 'data' | 'origin' | 'source'>,
  expectedSource: MessageEventSource | null,
  targetOrigin: string,
): boolean {
  return (
    event.source === expectedSource &&
    event.origin === targetOrigin &&
    event.data?.type === AW_CONNECT_MESSAGE &&
    event.data.version === AW_BRIDGE_VERSION
  );
}

function createBridge(port: MessagePort, requestTimeoutMs: number): HostApi {
  const listeners = new Map<HostEventName, Set<(payload: never) => void>>();
  const pending = new Map<
    string,
    {
      reject: (reason?: unknown) => void;
      resolve: (value: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  port.onmessage = (event: MessageEvent<BridgeEnvelope>) => {
    const envelope = event.data;
    if (isBridgeEventEnvelope(envelope)) {
      const eventListeners = listeners.get(envelope.event);
      eventListeners?.forEach((listener) => listener(envelope.payload as never));
      return;
    }
    if (!isBridgeResponseEnvelope(envelope)) return;

    const request = pending.get(envelope.id);
    if (!request) return;
    pending.delete(envelope.id);
    globalThis.clearTimeout(request.timer);
    if (envelope.error) {
      request.reject(new Error(`${envelope.error.code}: ${envelope.error.message}`));
      return;
    }
    request.resolve(envelope.result);
  };
  port.start();

  function invoke<TResult>(method: BridgeMethod, params?: unknown): Promise<TResult> {
    const id = crypto.randomUUID();
    return new Promise<TResult>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Host bridge request timed out: ${method}`));
      }, requestTimeoutMs);
      pending.set(id, { resolve: (value) => resolve(value as TResult), reject, timer });
      port.postMessage({ id, kind: 'request', method, params } satisfies BridgeRequestEnvelope);
    });
  }

  return {
    version: AW_BRIDGE_VERSION,
    broker: {
      request: (request) => invoke('broker.request', request),
    },
    events: {
      on: (event, listener) => {
        const eventListeners = listeners.get(event) ?? new Set();
        eventListeners.add(listener as (payload: never) => void);
        listeners.set(event, eventListeners);
        return () => eventListeners.delete(listener as (payload: never) => void);
      },
    },
    navigation: {
      navigate: (to, navigationOptions) => invoke('navigation.navigate', { options: navigationOptions, to }),
    },
    route: { getCurrent: () => invoke('route.getCurrent') },
    theme: { getCurrent: () => invoke('theme.getCurrent') },
    user: { getSummary: () => invoke('user.getSummary') },
    workspace: { getCurrent: () => invoke('workspace.getCurrent') },
  };
}

function isBridgeEventEnvelope(value: unknown): value is BridgeEventEnvelope {
  return isRecord(value) && value.kind === 'event' && HOST_EVENTS.has(value.event as HostEventName);
}

function isBridgeResponseEnvelope(value: unknown): value is BridgeResponseEnvelope {
  return isRecord(value) && value.kind === 'response' && typeof value.id === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const BRIDGE_METHODS: ReadonlySet<BridgeMethod> = new Set([
  'broker.request',
  'navigation.navigate',
  'route.getCurrent',
  'theme.getCurrent',
  'user.getSummary',
  'workspace.getCurrent',
]);

const HOST_EVENTS: ReadonlySet<HostEventName> = new Set([
  'route.changed',
  'theme.changed',
  'workspace.changed',
]);
