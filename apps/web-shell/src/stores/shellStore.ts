import type { LocalePreference, SupportedLocale } from '@awesome-workflow/contracts';
import { createLocaleSnapshot, detectBrowserLocale, writeLocalePreference } from '@awesome-workflow/i18n';
import type { BrowserLocaleEnvironment } from '@awesome-workflow/i18n';
import type { LocaleSnapshot, ThemeSnapshot, WorkspaceSummary } from '@awesome-workflow/web-sdk';
import { create } from 'zustand';

type ThemePreference = ThemeSnapshot['preference'];

type ShellState = {
  collapsed: boolean;
  localePreference: LocalePreference;
  localeSnapshot: LocaleSnapshot;
  refreshSystemLocale: () => void;
  resolvedTheme: ThemeSnapshot['resolved'];
  setCollapsed: (collapsed: boolean) => void;
  setLocalePreference: (preference: LocalePreference) => void;
  setThemePreference: (preference: ThemePreference) => void;
  setWorkspace: (workspace: WorkspaceSummary) => void;
  themePreference: ThemePreference;
  workspace: WorkspaceSummary | null;
};

const systemPrefersDark = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
const resolveTheme = (preference: ThemePreference): ThemeSnapshot['resolved'] =>
  preference === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : preference;

const initialPreference = (
  typeof localStorage === 'undefined' ? null : localStorage.getItem('aw-theme')
) as ThemePreference | null;

function getLocaleEnvironment() {
  if (typeof window === 'undefined') {
    return { languages: [] as string[], storage: undefined, timeZone: 'UTC' };
  }
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    storage = undefined;
  }
  return {
    languages: navigator.languages,
    storage,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export function resolveInitialShellLocale(environment: BrowserLocaleEnvironment, search: string) {
  const requested = new URLSearchParams(search).get('locale');
  const explicit: SupportedLocale | null = requested === 'en-US' || requested === 'zh-CN' ? requested : null;
  if (!explicit) return detectBrowserLocale(environment);
  return {
    preference: explicit,
    snapshot: createLocaleSnapshot(explicit, environment),
  };
}

const initialLocale = resolveInitialShellLocale(
  getLocaleEnvironment(),
  typeof window === 'undefined' ? '' : window.location.search,
);

export const useShellStore = create<ShellState>((set) => ({
  collapsed: false,
  localePreference: initialLocale.preference,
  localeSnapshot: initialLocale.snapshot,
  refreshSystemLocale: () =>
    set((state) =>
      state.localePreference === 'system'
        ? { localeSnapshot: createLocaleSnapshot('system', getLocaleEnvironment()) }
        : state,
    ),
  resolvedTheme: resolveTheme(initialPreference ?? 'light'),
  setCollapsed: (collapsed) => set({ collapsed }),
  setLocalePreference: (localePreference) => {
    const environment = getLocaleEnvironment();
    writeLocalePreference(environment.storage, localePreference);
    set({
      localePreference,
      localeSnapshot: createLocaleSnapshot(localePreference, environment),
    });
  },
  setThemePreference: (themePreference) => {
    localStorage.setItem('aw-theme', themePreference);
    set({ resolvedTheme: resolveTheme(themePreference), themePreference });
  },
  setWorkspace: (workspace) => set({ workspace }),
  themePreference: initialPreference ?? 'light',
  workspace: null,
}));

export const selectCollapsed = (state: ShellState) => state.collapsed;
export const selectLocalePreference = (state: ShellState) => state.localePreference;
export const selectLocaleSnapshot = (state: ShellState) => state.localeSnapshot;
export const selectRefreshSystemLocale = (state: ShellState) => state.refreshSystemLocale;
export const selectResolvedTheme = (state: ShellState) => state.resolvedTheme;
export const selectThemePreference = (state: ShellState) => state.themePreference;
export const selectWorkspace = (state: ShellState) => state.workspace;
export const selectSetCollapsed = (state: ShellState) => state.setCollapsed;
export const selectSetLocalePreference = (state: ShellState) => state.setLocalePreference;
export const selectSetThemePreference = (state: ShellState) => state.setThemePreference;
export const selectSetWorkspace = (state: ShellState) => state.setWorkspace;
