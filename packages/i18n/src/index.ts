import type {
  ApplicationLocalizations,
  LocalePreference,
  LocaleSnapshot,
  LocalizedApplicationContent,
  SupportedLocale,
} from '@awesome-workflow/contracts';
import { createInstance, type i18n, type Resource } from 'i18next';

export const SUPPORTED_LOCALES = ['en-US', 'zh-CN'] as const satisfies readonly SupportedLocale[];
export const DEFAULT_LOCALE: SupportedLocale = 'en-US';
export const LOCALE_STORAGE_KEY = 'awesome-workflow.locale.v1';

export type LocaleEnvironment = {
  languages?: readonly string[];
  timeZone?: string;
};

export type BrowserLocaleEnvironment = LocaleEnvironment & {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
};

export function normalizeLocale(value: string | null | undefined): SupportedLocale | null {
  if (!value) return null;
  const normalized = value.trim().replaceAll('_', '-').toLowerCase();
  if (normalized === 'zh' || normalized.startsWith('zh-')) {
    return 'zh-CN';
  }
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en-US';
  return null;
}

export function parseLocalePreference(value: string | null | undefined): LocalePreference | null {
  if (value === 'system') return 'system';
  return normalizeLocale(value);
}

export function resolveLocale(
  preference: LocalePreference,
  languages: readonly string[] = [],
): SupportedLocale {
  if (preference !== 'system') return preference;
  for (const language of languages) {
    const locale = normalizeLocale(language);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

export function readLocalePreference(storage: Pick<Storage, 'getItem'> | undefined): LocalePreference {
  try {
    return parseLocalePreference(storage?.getItem(LOCALE_STORAGE_KEY)) ?? 'system';
  } catch {
    return 'system';
  }
}

export function writeLocalePreference(
  storage: Pick<Storage, 'setItem'> | undefined,
  preference: LocalePreference,
): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, preference);
  } catch {
    // A denied or full browser storage area must not make the UI unusable.
  }
}

export function createLocaleSnapshot(
  preference: LocalePreference,
  environment: LocaleEnvironment = {},
): LocaleSnapshot {
  const locale = resolveLocale(preference, environment.languages);
  return {
    locale,
    fallbackLocales: locale === DEFAULT_LOCALE ? [] : [DEFAULT_LOCALE],
    direction: 'ltr',
    timeZone: environment.timeZone || 'UTC',
  };
}

export function detectBrowserLocale(environment: BrowserLocaleEnvironment = {}): {
  preference: LocalePreference;
  snapshot: LocaleSnapshot;
} {
  const preference = readLocalePreference(environment.storage);
  return {
    preference,
    snapshot: createLocaleSnapshot(preference, {
      languages: environment.languages,
      timeZone: environment.timeZone,
    }),
  };
}

export function applyDocumentLocale(snapshot: LocaleSnapshot, document: Document): void {
  document.documentElement.lang = snapshot.locale;
  document.documentElement.dir = snapshot.direction;
}

export async function createAppI18n(
  resources: Resource,
  locale: SupportedLocale = DEFAULT_LOCALE,
): Promise<i18n> {
  const instance = createInstance();
  await instance.init({
    resources,
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALES,
    load: 'currentOnly',
    ns: ['translation'],
    defaultNS: 'translation',
    interpolation: { escapeValue: false },
    returnEmptyString: false,
    returnNull: false,
    showSupportNotice: false,
  });
  return instance;
}

export function formatDateTime(
  value: Date | number | string,
  snapshot: LocaleSnapshot,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(snapshot.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: snapshot.timeZone,
    ...options,
  }).format(date);
}

export function formatNumber(
  value: number,
  snapshot: Pick<LocaleSnapshot, 'locale'>,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(snapshot.locale, options).format(value);
}

export function formatBytes(value: number, snapshot: Pick<LocaleSnapshot, 'locale'>): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${formatNumber(size, snapshot, {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  })} ${units[unit]}`;
}

export function resolveLocalizedContent<T extends { name: string; summary?: string; description?: string }>(
  source: T,
  localizations: ApplicationLocalizations | undefined,
  locale: SupportedLocale,
  fallbackLocales: readonly SupportedLocale[] = [DEFAULT_LOCALE],
): T {
  const candidates = [locale, ...fallbackLocales].filter(
    (candidate, index, all) => all.indexOf(candidate) === index,
  );
  const overlay = candidates.reduce<LocalizedApplicationContent>(
    (resolved, candidate) => ({ ...localizations?.[candidate], ...resolved }),
    {},
  );
  return { ...source, ...overlay };
}
