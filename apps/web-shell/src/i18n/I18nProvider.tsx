import enUS from '@arco-design/web-react/es/locale/en-US';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import { applyDocumentLocale, createAppI18n } from '@awesome-workflow/i18n';
import type { SupportedLocale } from '@awesome-workflow/web-sdk';
import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';

import { selectLocaleSnapshot, selectRefreshSystemLocale, useShellStore } from '../stores/shellStore';
import { shellResources } from './messages';

type ShellI18n = Awaited<ReturnType<typeof createAppI18n>>;
type TranslationValues = Record<string, boolean | number | string | undefined>;

type I18nContextValue = {
  arcoLocale: typeof enUS;
  locale: SupportedLocale;
  t: (key: string, values?: TranslationValues) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export async function createShellI18n(): Promise<ShellI18n> {
  return createAppI18n(shellResources, useShellStore.getState().localeSnapshot.locale);
}

export function ShellI18nProvider({ children, instance }: PropsWithChildren<{ instance: ShellI18n }>) {
  const snapshot = useShellStore(selectLocaleSnapshot);
  const refreshSystemLocale = useShellStore(selectRefreshSystemLocale);
  const [activeLocale, setActiveLocale] = useState(snapshot.locale);

  useEffect(() => {
    applyDocumentLocale(snapshot, document);
    let active = true;
    void instance.changeLanguage(snapshot.locale).then(() => {
      if (!active) return;
      setActiveLocale(snapshot.locale);
    });
    return () => {
      active = false;
    };
  }, [instance, snapshot]);

  useEffect(() => {
    window.addEventListener('languagechange', refreshSystemLocale);
    return () => window.removeEventListener('languagechange', refreshSystemLocale);
  }, [refreshSystemLocale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      arcoLocale: activeLocale === 'zh-CN' ? zhCN : enUS,
      locale: activeLocale,
      t: (key, values) => String(instance.t(key, values)),
    }),
    [activeLocale, instance],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('ShellI18nProvider is missing');
  return value;
}
