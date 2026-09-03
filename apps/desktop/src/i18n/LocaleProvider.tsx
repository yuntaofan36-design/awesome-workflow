import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfigProvider, Message } from '@arco-design/web-react';
import arcoEnUS from '@arco-design/web-react/es/locale/en-US';
import arcoZhCN from '@arco-design/web-react/es/locale/zh-CN';

import {
  createLocaleSnapshot,
  formatBytes as formatLocaleBytes,
  formatDateTime as formatLocaleDateTime,
  formatNumber as formatLocaleNumber,
  writeLocalePreference,
} from '@awesome-workflow/i18n';

import { resolveDesktopApplicationContent } from './applicationContent';
import { LocaleContext, type LocaleContextValue, type Translate } from './localeContext';
import { createLocaleSyncWarningGate, synchronizeAgentLocaleWithRetry } from './localeSync';
import { createLocaleTransitionQueue } from './localeTransition';
import {
  applyLocaleSideEffects,
  browserLanguages,
  browserTimeZone,
  type DesktopLocalePreference,
  type DesktopLocaleRuntime,
} from './runtime';
import { formatUiError, normalizeUiError } from './errors';
import { setDesktopRequestLocale } from './requestLocale';

export function LocaleProvider({
  children,
  runtime,
}: {
  children: ReactNode;
  runtime: DesktopLocaleRuntime;
}) {
  const [preference, setPreferenceState] = useState(runtime.preference);
  const [snapshot, setSnapshot] = useState(runtime.snapshot);
  const [syncWarningGate] = useState(createLocaleSyncWarningGate);
  const [localeTransitions] = useState(createLocaleTransitionQueue);
  const syncGeneration = useRef(0);
  const [syncRetry, setSyncRetry] = useState(0);
  const [agentLocaleSync, setAgentLocaleSync] = useState<LocaleContextValue['agentLocaleSync']>({
    status: 'syncing',
    error: null,
  });
  const { i18n } = runtime;

  const applyPreference = useCallback(
    async (nextPreference: DesktopLocalePreference, persist: boolean) => {
      const nextSnapshot = createLocaleSnapshot(nextPreference, {
        languages: browserLanguages(),
        timeZone: browserTimeZone(),
      });
      await localeTransitions.run(
        () => i18n.changeLanguage(nextSnapshot.locale),
        () => {
          if (persist) writeLocalePreference(window.localStorage, nextPreference);
          setDesktopRequestLocale(nextSnapshot.locale);
          applyLocaleSideEffects(i18n, nextSnapshot);
          setPreferenceState(nextPreference);
          setSnapshot(nextSnapshot);
        },
      );
    },
    [i18n, localeTransitions],
  );

  const setPreference = useCallback(
    (nextPreference: DesktopLocalePreference) => applyPreference(nextPreference, true),
    [applyPreference],
  );
  const retryAgentLocaleSync = useCallback(() => setSyncRetry((value) => value + 1), []);

  useEffect(() => {
    if (preference !== 'system') return undefined;
    const onLanguageChange = () => void applyPreference('system', false);
    window.addEventListener('languagechange', onLanguageChange);
    return () => window.removeEventListener('languagechange', onLanguageChange);
  }, [applyPreference, preference]);

  const t = useCallback<Translate>(
    (key, values) => String(i18n.t(key, values)),
    // The snapshot dependency makes the callback identity follow the active catalog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18n, snapshot.locale],
  );

  useEffect(() => {
    const generation = ++syncGeneration.current;
    let active = true;
    setAgentLocaleSync({ status: 'syncing', error: null });
    void synchronizeAgentLocaleWithRetry(snapshot, {
      isCurrent: () => active && generation === syncGeneration.current,
    })
      .then(() => {
        if (active && generation === syncGeneration.current) {
          syncWarningGate.succeeded();
          setAgentLocaleSync({ status: 'synced', error: null });
        }
      })
      .catch((error: unknown) => {
        if (active && generation === syncGeneration.current) {
          const normalized = normalizeUiError(error, 'locale_sync_failed');
          setAgentLocaleSync({ status: 'error', error: normalized });
          if (syncWarningGate.failed(snapshot)) {
            Message.warning(formatUiError(normalized, t));
          }
        }
      });
    return () => {
      active = false;
    };
  }, [snapshot, syncRetry, syncWarningGate, t]);

  const value = useMemo<LocaleContextValue>(
    () => ({
      i18n,
      preference,
      snapshot,
      t,
      setPreference,
      agentLocaleSync,
      retryAgentLocaleSync,
      formatDateTime: (date, options) => formatLocaleDateTime(date, snapshot, options),
      formatNumber: (number, options) => formatLocaleNumber(number, snapshot, options),
      formatBytes: (bytes) => formatLocaleBytes(bytes, snapshot),
      resolveApplicationContent: (source, localizations) =>
        resolveDesktopApplicationContent(source, localizations, snapshot),
    }),
    [agentLocaleSync, i18n, preference, retryAgentLocaleSync, setPreference, snapshot, t],
  );

  return (
    <LocaleContext.Provider value={value}>
      <ConfigProvider locale={snapshot.locale === 'zh-CN' ? arcoZhCN : arcoEnUS}>{children}</ConfigProvider>
    </LocaleContext.Provider>
  );
}
