import { getCurrentWindow } from '@tauri-apps/api/window';

import {
  applyDocumentLocale,
  createAppI18n,
  createLocaleSnapshot,
  detectBrowserLocale,
} from '@awesome-workflow/i18n';

import { desktopResources } from './resources';
import { setDesktopRequestLocale } from './requestLocale';

export type DesktopLocalePreference = 'system' | 'en-US' | 'zh-CN';
export type DesktopLocaleSnapshot = ReturnType<typeof createLocaleSnapshot>;
export type DesktopI18n = Awaited<ReturnType<typeof createAppI18n>>;

export type DesktopLocaleRuntime = {
  i18n: DesktopI18n;
  preference: DesktopLocalePreference;
  snapshot: DesktopLocaleSnapshot;
};

export async function initializeDesktopLocale(): Promise<DesktopLocaleRuntime> {
  const detected = detectBrowserLocale({
    languages: browserLanguages(),
    storage: window.localStorage,
    timeZone: browserTimeZone(),
  });
  setDesktopRequestLocale(detected.snapshot.locale);
  const i18n = await createAppI18n(desktopResources, detected.snapshot.locale);
  applyLocaleSideEffects(i18n, detected.snapshot);
  return { i18n, preference: detected.preference, snapshot: detected.snapshot };
}

export function browserLanguages(): readonly string[] {
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function applyLocaleSideEffects(i18n: DesktopI18n, snapshot: DesktopLocaleSnapshot): void {
  applyDocumentLocale(snapshot, document);
  const title = String(i18n.t('app.documentTitle'));
  document.title = title;
  if ('__TAURI_INTERNALS__' in window) {
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {
        // The document title remains correct if the native title API is unavailable.
      });
  }
}
