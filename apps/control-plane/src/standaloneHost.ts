import type {
  BrokerRequest,
  BrokerResult,
  HostApi,
  HostEventMap,
  HostEventName,
} from '@awesome-workflow/web-sdk';

export function createStandaloneHost(): HostApi {
  const listeners = new Map<HostEventName, Set<(payload: never) => void>>();
  return {
    version: 1,
    broker: {
      request: async <TRequest extends BrokerRequest>(request: TRequest): Promise<BrokerResult<TRequest>> => {
        if (request.operation === 'notifications.show') {
          console.info(request.payload.message);
          return undefined as BrokerResult<TRequest>;
        }
        return [] as unknown as BrokerResult<TRequest>;
      },
    },
    events: {
      on: <TEvent extends HostEventName>(
        event: TEvent,
        listener: (payload: HostEventMap[TEvent]) => void,
      ) => {
        const eventListeners = listeners.get(event) ?? new Set();
        eventListeners.add(listener as (payload: never) => void);
        listeners.set(event, eventListeners);
        return () => eventListeners.delete(listener as (payload: never) => void);
      },
    },
    navigation: {
      navigate: async (to, options) => {
        window.history[options?.replace ? 'replaceState' : 'pushState']({}, '', to);
      },
    },
    route: {
      getCurrent: async () => ({
        hash: window.location.hash,
        pathname: window.location.pathname,
        search: window.location.search,
      }),
    },
    theme: { getCurrent: async () => ({ preference: 'system', resolved: 'light' }) },
    user: {
      getSummary: async () => ({
        displayName: 'Standalone administrator',
        email: 'admin@example.com',
        id: '00000000-0000-4000-8000-000000000001',
        platformRoles: ['platform_admin'],
      }),
    },
    workspace: {
      getCurrent: async () => ({
        id: '00000000-0000-4000-8000-000000000010',
        name: 'Default workspace',
        role: 'owner',
        slug: 'default',
      }),
    },
  };
}
