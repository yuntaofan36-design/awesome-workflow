import type {
  ApplicationLocalizations,
  LocalePreference,
  LocaleSnapshot,
  SupportedLocale,
} from '@awesome-workflow/contracts';
import {
  applyDocumentLocale,
  createAppI18n,
  formatBytes as formatLocalizedBytes,
  formatDateTime as formatLocalizedDateTime,
  formatNumber as formatLocalizedNumber,
  resolveLocalizedContent,
} from '@awesome-workflow/i18n';
import { createContext, useContext, type ReactNode } from 'react';

import { ApiProblemError } from './apiClient';
import { enUS } from './locales/en-US';
import { zhCN } from './locales/zh-CN';

export const controlPlaneResources = {
  'en-US': { translation: enUS },
  'zh-CN': { translation: zhCN },
} as const;

export type ControlPlaneI18nInstance = Awaited<ReturnType<typeof createAppI18n>>;

export type StandaloneLocaleControls = {
  preference: LocalePreference;
  setPreference: (preference: LocalePreference) => void;
};

type I18nContextValue = {
  instance: ControlPlaneI18nInstance;
  locale: LocaleSnapshot;
  standaloneLocale?: StandaloneLocaleControls;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export async function createControlPlaneI18n(locale: SupportedLocale): Promise<ControlPlaneI18nInstance> {
  return createAppI18n(controlPlaneResources, locale);
}

export function ControlPlaneI18nProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: I18nContextValue;
}) {
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useControlPlaneI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error('ControlPlaneI18nProvider is missing');

  const t = (key: string, values?: Record<string, string | number | undefined>): string =>
    context.instance.t(key, values);
  const formatDateTime = (value: Date | number | string): string =>
    formatLocalizedDateTime(value, context.locale);
  const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string =>
    formatLocalizedNumber(value, context.locale, options);
  const formatBytes = (value: number): string => formatLocalizedBytes(value, context.locale);
  const localizeContent = <T extends { name: string; summary?: string; description?: string }>(
    source: T,
    localizations: ApplicationLocalizations | undefined,
    defaultLocale: SupportedLocale,
  ): T =>
    resolveLocalizedContent(source, localizations, context.locale.locale, [
      defaultLocale,
      ...context.locale.fallbackLocales,
    ]);

  return {
    ...context,
    formatBytes,
    formatDateTime,
    formatNumber,
    localizeContent,
    t,
    translateError: (error: unknown) => translateControlPlaneError(context.instance, error),
  };
}

export function applyControlPlaneDocumentLocale(
  instance: ControlPlaneI18nInstance,
  locale: LocaleSnapshot,
  target: Document,
  options: { ownsTitle?: boolean } = {},
): void {
  applyDocumentLocale(locale, target);
  if (options.ownsTitle !== false) target.title = instance.t('app.documentTitle');
}

export function translateControlPlaneError(instance: ControlPlaneI18nInstance, error: unknown): string {
  if (!(error instanceof ApiProblemError)) return instance.t('errors.unexpected');

  const key = error.code ? `errors.problem.${error.code}` : undefined;
  const localized =
    key && instance.exists(key)
      ? instance.t(key)
      : error.problem.detail ||
        error.problem.title ||
        instance.t('errors.requestFailed', { status: error.status });
  return error.code ? instance.t('errors.withCode', { code: error.code, message: localized }) : localized;
}
