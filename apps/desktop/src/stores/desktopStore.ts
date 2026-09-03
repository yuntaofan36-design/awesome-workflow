import { create } from 'zustand';

import { normalizeUiError, type UiError } from '@/i18n/errors';
import { desktopHost } from '@/services/desktopHost';
import type { AgentSnapshot, AppletManifest } from '@/types';

type DesktopState = {
  snapshot: AgentSnapshot | null;
  loading: boolean;
  error: UiError | null;
  validatedManifest: AppletManifest | null;
  refresh: () => Promise<void>;
  run: (appId: string, version?: string) => Promise<void>;
  stop: (taskId: string) => Promise<void>;
  validateDirectory: (path: string) => Promise<void>;
  registerDirectory: (path: string) => Promise<void>;
};

export const useDesktopStore = create<DesktopState>()((set, get) => ({
  snapshot: null,
  loading: false,
  error: null,
  validatedManifest: null,
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      set({ snapshot: await desktopHost.snapshot(), loading: false });
    } catch (error) {
      set({ error: normalizeUiError(error, 'agent_snapshot_failed'), loading: false });
    }
  },
  run: async (appId, version) => {
    set({ loading: true, error: null });
    try {
      await desktopHost.runApplet(appId, version);
      await get().refresh();
    } catch (error) {
      set({ error: normalizeUiError(error, 'applet_run_failed'), loading: false });
    }
  },
  stop: async (taskId) => {
    set({ loading: true, error: null });
    try {
      await desktopHost.stopTask(taskId);
      await get().refresh();
    } catch (error) {
      set({ error: normalizeUiError(error, 'task_stop_failed'), loading: false });
    }
  },
  validateDirectory: async (path) => {
    set({ loading: true, error: null, validatedManifest: null });
    try {
      set({ validatedManifest: await desktopHost.validateDevelopmentApplet(path), loading: false });
    } catch (error) {
      set({ error: normalizeUiError(error, 'applet_validation_failed'), loading: false });
    }
  },
  registerDirectory: async (path) => {
    set({ loading: true, error: null });
    try {
      await desktopHost.registerDevelopmentApplet(path);
      await get().refresh();
    } catch (error) {
      set({
        error: normalizeUiError(error, 'development_applet_registration_failed'),
        loading: false,
      });
    }
  },
}));

export const selectSnapshot = (state: DesktopState) => state.snapshot;
export const selectDesktopLoading = (state: DesktopState) => state.loading;
export const selectDesktopError = (state: DesktopState) => state.error;
export const selectRefreshDesktop = (state: DesktopState) => state.refresh;
export const selectRunApplet = (state: DesktopState) => state.run;
export const selectStopTask = (state: DesktopState) => state.stop;
export const selectValidatedManifest = (state: DesktopState) => state.validatedManifest;
export const selectValidateDirectory = (state: DesktopState) => state.validateDirectory;
export const selectRegisterDirectory = (state: DesktopState) => state.registerDirectory;
