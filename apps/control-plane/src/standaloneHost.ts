import type { LocalePreference, LocaleSnapshot } from '@awesome-workflow/contracts';
import { createLocaleSnapshot, detectBrowserLocale, writeLocalePreference } from '@awesome-workflow/i18n';
import type {
  BrokerRequest,
  BrokerResult,
  HostApi,
  HostEventMap,
  HostEventName,
} from '@awesome-workflow/web-sdk';

import type { StandaloneLocaleControls } from './i18n';

const STANDALONE_LOCALE = Symbol('awesome-workflow.control-plane.standalone-locale');

type StandaloneHost = HostApi & {
  [STANDALONE_LOCALE]: StandaloneLocaleControls;
};

export function createStandaloneHost(): StandaloneHost {
  const listeners = new Map<HostEventName, Set<(payload: never) => void>>();
  const storage = browserStorage();
  const detected = detectBrowserLocale({
    languages: navigator.languages,
    storage,
    timeZone: browserTimeZone(),
  });
  let preference = detected.preference;
  let locale = detected.snapshot;

  const emit = <TEvent extends HostEventName>(event: TEvent, payload: HostEventMap[TEvent]): void => {
    listeners.get(event)?.forEach((listener) => listener(payload as never));
  };
  const refreshSystemLocale = (): void => {
    if (preference !== 'system') return;
    locale = createLocaleSnapshot('system', {
      languages: navigator.languages,
      timeZone: browserTimeZone(),
    });
    emit('locale.changed', locale);
  };
  window.addEventListener('languagechange', refreshSystemLocale);

  const standaloneLocale: StandaloneLocaleControls = {
    get preference() {
      return preference;
    },
    setPreference: (nextPreference: LocalePreference) => {
      preference = nextPreference;
      writeLocalePreference(storage, preference);
      locale = createLocaleSnapshot(preference, {
        languages: navigator.languages,
        timeZone: browserTimeZone(),
      });
      emit('locale.changed', locale);
    },
  };

  return {
    [STANDALONE_LOCALE]: standaloneLocale,
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
    locale: { getCurrent: async () => locale },
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

export function getStandaloneLocaleControls(host: HostApi): StandaloneLocaleControls | undefined {
  return STANDALONE_LOCALE in host ? (host as StandaloneHost)[STANDALONE_LOCALE] : undefined;
}

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
