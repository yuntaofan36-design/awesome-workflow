import { desktopHost } from '../services/desktopHost';

import type { DesktopLocaleSnapshot } from './runtime';

const retryDelaysMs = [250, 1_000] as const;
let localeSyncQueue: Promise<unknown> = Promise.resolve();

export type LocaleSyncWarningGate = {
  failed: (snapshot: DesktopLocaleSnapshot) => boolean;
  succeeded: () => void;
};

export function synchronizeAgentLocale(snapshot: DesktopLocaleSnapshot) {
  const request = localeSyncQueue
    .catch(() => undefined)
    .then(() => desktopHost.setLocale(snapshot.locale, [...snapshot.fallbackLocales]));
  localeSyncQueue = request;
  return request;
}

export async function synchronizeAgentLocaleWithRetry(
  snapshot: DesktopLocaleSnapshot,
  options: {
    synchronize?: typeof synchronizeAgentLocale;
    wait?: (milliseconds: number) => Promise<void>;
    isCurrent?: () => boolean;
  } = {},
): Promise<void> {
  const synchronize = options.synchronize ?? synchronizeAgentLocale;
  const wait = options.wait ?? waitForRetry;
  const isCurrent = options.isCurrent ?? (() => true);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    if (!isCurrent()) throw new Error('locale sync was superseded');
    try {
      await synchronize(snapshot);
      return;
    } catch (error) {
      lastError = error;
      if (!isCurrent() || attempt === retryDelaysMs.length) break;
      await wait(retryDelaysMs[attempt]!);
    }
  }
  throw lastError;
}

export function createLocaleSyncWarningGate(): LocaleSyncWarningGate {
  let lastFailureKey: string | null = null;
  return {
    failed(snapshot) {
      const key = `${snapshot.locale}|${snapshot.fallbackLocales.join(',')}`;
      if (key === lastFailureKey) return false;
      lastFailureKey = key;
      return true;
    },
    succeeded() {
      lastFailureKey = null;
    },
  };
}

function waitForRetry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
