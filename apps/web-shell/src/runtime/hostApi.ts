import type {
  BridgeRequestEnvelope,
  BridgeResponseEnvelope,
  BrokerRequest,
  CatalogItemSummary,
  HostApi,
  HostEventName,
  RouteSnapshot,
  ThemeSnapshot,
  UserSummary,
  WorkspaceSummary,
} from '@awesome-workflow/web-sdk';
import { isBridgeRequestEnvelope } from '@awesome-workflow/web-sdk';

import type { CatalogEntry } from '../types/catalog';
import type { HostEventBus } from './eventBus';

type HostServices = {
  catalog: (channel?: 'canary' | 'dev' | 'stable') => Promise<readonly CatalogEntry[]>;
  events: HostEventBus;
  navigate: (to: string, options?: { replace?: boolean }) => void;
  notify: (message: string, level: 'error' | 'info' | 'success' | 'warning') => void;
  route: () => RouteSnapshot;
  theme: () => ThemeSnapshot;
  user: () => UserSummary;
  workspace: () => WorkspaceSummary;
};

export function createScopedHostApi(entry: CatalogEntry, services: HostServices): HostApi {
  const capabilities = new Set<string>(entry.manifest.runtime === 'link' ? [] : entry.manifest.capabilities);
  const requireCapability = (capability: string) => {
    if (!capabilities.has(capability))
      throw new HostApiError('capability_denied', `Application lacks ${capability}`);
  };

  return {
    version: 1,
    broker: {
      request: async (request) => {
        if (request.operation === 'notifications.show') {
          requireCapability('notifications');
          validateNotification(request);
          services.notify(request.payload.message, request.payload.level ?? 'info');
          return undefined as never;
        }
        if (request.operation === 'catalog.list') {
          requireCapability('api.fetch');
          const entries = await services.catalog(request.payload?.channel);
          return entries.map(toCatalogSummary) as never;
        }
        throw new HostApiError('operation_denied', 'Broker operation is not allowlisted');
      },
    },
    events: {
      on: (event, listener) => {
        requireCapability('context.read');
        return services.events.on(event, listener);
      },
    },
    navigation: {
      navigate: async (to, options) => {
        requireCapability('navigation');
        services.navigate(assertInternalRoute(to), options);
      },
    },
    route: {
      getCurrent: async () => {
        requireCapability('context.read');
        return services.route();
      },
    },
    theme: {
      getCurrent: async () => {
        requireCapability('context.read');
        return services.theme();
      },
    },
    user: {
      getSummary: async () => {
        requireCapability('context.read');
        return services.user();
      },
    },
    workspace: {
      getCurrent: async () => {
        requireCapability('context.read');
        return services.workspace();
      },
    },
  };
}

export function serveHostApi(port: MessagePort, api: HostApi): () => void {
  const unsubscribers: Array<() => void> = [];
  for (const event of ['route.changed', 'theme.changed', 'workspace.changed'] as const) {
    try {
      unsubscribers.push(
        api.events.on(event, (payload) => port.postMessage({ event, kind: 'event', payload })),
      );
    } catch (error) {
      if (!(error instanceof HostApiError) || error.code !== 'capability_denied') throw error;
    }
  }

  port.onmessage = (event: MessageEvent<unknown>) => {
    const request = event.data;
    if (!isBridgeRequestEnvelope(request)) return;
    void dispatchBridgeRequest(api, request)
      .then((result) =>
        port.postMessage({ id: request.id, kind: 'response', result } satisfies BridgeResponseEnvelope),
      )
      .catch((error: unknown) => {
        const normalized = normalizeHostError(error);
        port.postMessage({
          id: request.id,
          kind: 'response',
          error: normalized,
        } satisfies BridgeResponseEnvelope);
      });
  };
  port.start();

  return () => {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    port.close();
  };
}

async function dispatchBridgeRequest(api: HostApi, request: BridgeRequestEnvelope): Promise<unknown> {
  switch (request.method) {
    case 'user.getSummary':
      return api.user.getSummary();
    case 'workspace.getCurrent':
      return api.workspace.getCurrent();
    case 'theme.getCurrent':
      return api.theme.getCurrent();
    case 'route.getCurrent':
      return api.route.getCurrent();
    case 'navigation.navigate': {
      const params = expectRecord(request.params);
      const options = params.options === undefined ? undefined : expectRecord(params.options);
      return api.navigation.navigate(expectString(params.to), { replace: options?.replace === true });
    }
    case 'broker.request':
      return api.broker.request(validateBrokerRequest(request.params));
  }
}

function validateBrokerRequest(value: unknown): BrokerRequest {
  const request = expectRecord(value);
  if (request.operation === 'notifications.show') {
    const payload = expectRecord(request.payload);
    return {
      operation: 'notifications.show',
      payload: {
        message: expectString(payload.message),
        ...(typeof payload.level === 'string' ? { level: expectNotificationLevel(payload.level) } : {}),
      },
    };
  }
  if (request.operation === 'catalog.list') {
    const payload = request.payload === undefined ? undefined : expectRecord(request.payload);
    const channel = payload?.channel;
    if (channel !== undefined && channel !== 'dev' && channel !== 'canary' && channel !== 'stable') {
      throw new HostApiError('invalid_request', 'Invalid catalog channel');
    }
    return {
      operation: 'catalog.list',
      ...(payload ? { payload: { ...(channel ? { channel } : {}) } } : {}),
    };
  }
  throw new HostApiError('operation_denied', 'Broker operation is not allowlisted');
}

function validateNotification(request: Extract<BrokerRequest, { operation: 'notifications.show' }>): void {
  const { message } = request.payload;
  if (!message.trim() || message.length > 240)
    throw new HostApiError('invalid_request', 'Notification message must be 1-240 characters');
}

function assertInternalRoute(to: string): string {
  if (!to.startsWith('/') || to.startsWith('//') || to.includes('\\')) {
    throw new HostApiError('navigation_denied', 'Only absolute in-shell routes are allowed');
  }
  const url = new URL(to, window.location.origin);
  if (url.origin !== window.location.origin)
    throw new HostApiError('navigation_denied', 'Cross-origin navigation is denied');
  return `${url.pathname}${url.search}${url.hash}`;
}

function toCatalogSummary(entry: CatalogEntry): CatalogItemSummary {
  return {
    id: entry.applicationId,
    name: entry.name,
    runtime: entry.manifest.runtime,
    slug: entry.slug,
    version: entry.version,
  };
}

function normalizeHostError(error: unknown): { code: string; message: string } {
  if (error instanceof HostApiError) return { code: error.code, message: error.message };
  return { code: 'host_error', message: error instanceof Error ? error.message : 'Host request failed' };
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null)
    throw new HostApiError('invalid_request', 'Expected an object');
  return value as Record<string, unknown>;
}

function expectString(value: unknown): string {
  if (typeof value !== 'string') throw new HostApiError('invalid_request', 'Expected a string');
  return value;
}

function expectNotificationLevel(value: string): 'error' | 'info' | 'success' | 'warning' {
  if (value === 'error' || value === 'info' || value === 'success' || value === 'warning') return value;
  throw new HostApiError('invalid_request', 'Invalid notification level');
}

class HostApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
