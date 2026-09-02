import { create } from 'zustand';

import { desktopHost } from '@/services/desktopHost';
import type { AgentSnapshot, AppletManifest } from '@/types';

type DesktopState = {
  snapshot: AgentSnapshot | null;
  loading: boolean;
  error: string | null;
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
      set({ error: describe(error), loading: false });
    }
  },
  run: async (appId, version) => {
    set({ loading: true, error: null });
    try {
      await desktopHost.runApplet(appId, version);
      await get().refresh();
    } catch (error) {
      set({ error: describe(error), loading: false });
    }
  },
  stop: async (taskId) => {
    set({ loading: true, error: null });
    try {
      await desktopHost.stopTask(taskId);
      await get().refresh();
    } catch (error) {
      set({ error: describe(error), loading: false });
    }
  },
  validateDirectory: async (path) => {
    set({ loading: true, error: null, validatedManifest: null });
    try {
      set({ validatedManifest: await desktopHost.validateDevelopmentApplet(path), loading: false });
    } catch (error) {
      set({ error: describe(error), loading: false });
    }
  },
  registerDirectory: async (path) => {
    set({ loading: true, error: null });
    try {
      await desktopHost.registerDevelopmentApplet(path);
      await get().refresh();
    } catch (error) {
      set({ error: describe(error), loading: false });
    }
  },
}));

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const selectSnapshot = (state: DesktopState) => state.snapshot;
export const selectDesktopLoading = (state: DesktopState) => state.loading;
export const selectDesktopError = (state: DesktopState) => state.error;
export const selectRefreshDesktop = (state: DesktopState) => state.refresh;
export const selectRunApplet = (state: DesktopState) => state.run;
export const selectStopTask = (state: DesktopState) => state.stop;
export const selectValidatedManifest = (state: DesktopState) => state.validatedManifest;
export const selectValidateDirectory = (state: DesktopState) => state.validateDirectory;
export const selectRegisterDirectory = (state: DesktopState) => state.registerDirectory;
