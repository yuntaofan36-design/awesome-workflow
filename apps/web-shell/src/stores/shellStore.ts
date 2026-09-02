import type { ThemeSnapshot, WorkspaceSummary } from '@awesome-workflow/web-sdk';
import { create } from 'zustand';

type ThemePreference = ThemeSnapshot['preference'];

type ShellState = {
  collapsed: boolean;
  resolvedTheme: ThemeSnapshot['resolved'];
  setCollapsed: (collapsed: boolean) => void;
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

export const useShellStore = create<ShellState>((set) => ({
  collapsed: false,
  resolvedTheme: resolveTheme(initialPreference ?? 'light'),
  setCollapsed: (collapsed) => set({ collapsed }),
  setThemePreference: (themePreference) => {
    localStorage.setItem('aw-theme', themePreference);
    set({ resolvedTheme: resolveTheme(themePreference), themePreference });
  },
  setWorkspace: (workspace) => set({ workspace }),
  themePreference: initialPreference ?? 'light',
  workspace: null,
}));

export const selectCollapsed = (state: ShellState) => state.collapsed;
export const selectResolvedTheme = (state: ShellState) => state.resolvedTheme;
export const selectThemePreference = (state: ShellState) => state.themePreference;
export const selectWorkspace = (state: ShellState) => state.workspace;
export const selectSetCollapsed = (state: ShellState) => state.setCollapsed;
export const selectSetThemePreference = (state: ShellState) => state.setThemePreference;
export const selectSetWorkspace = (state: ShellState) => state.setWorkspace;
