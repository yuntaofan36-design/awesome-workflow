import { createContext, useContext } from 'react';

import type { ApplicationLocalizations, LocalizableApplication } from './applicationContent';
import type { DesktopLocalePreference, DesktopLocaleRuntime, DesktopLocaleSnapshot } from './runtime';

type TranslationValues = Record<string, unknown>;
export type Translate = (key: string, values?: TranslationValues) => string;

export type AgentLocaleSyncState = {
  status: 'syncing' | 'synced' | 'error';
  error: import('./errors').UiError | null;
};

export type LocaleContextValue = DesktopLocaleRuntime & {
  t: Translate;
  setPreference: (preference: DesktopLocalePreference) => Promise<void>;
  agentLocaleSync: AgentLocaleSyncState;
  retryAgentLocaleSync: () => void;
  formatDateTime: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatBytes: (value: number) => string;
  resolveApplicationContent: <T extends LocalizableApplication>(
    source: T,
    localizations: ApplicationLocalizations | undefined,
  ) => T;
  snapshot: DesktopLocaleSnapshot;
};

export const LocaleContext = createContext<LocaleContextValue | null>(null);

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('useLocale must be used inside LocaleProvider');
  return context;
}
