import { create } from 'zustand';

import { sessionApi, type AuthProvider } from '@/services/session';
import type { CurrentUser } from '@/types';

type SessionState = {
  initialized: boolean;
  loading: boolean;
  user: CurrentUser | null;
  expiresAt: string | null;
  providers: AuthProvider[];
  error: string | null;
  initialize: () => Promise<void>;
  login: () => Promise<void>;
  logout: () => Promise<void>;
};

export const useSessionStore = create<SessionState>()((set) => ({
  initialized: false,
  loading: false,
  user: null,
  expiresAt: null,
  providers: [],
  error: null,
  initialize: async () => {
    set({ loading: true, error: null });
    let providers: AuthProvider[] = [];
    let providerError: string | null = null;
    try {
      providers = await sessionApi.providers();
    } catch (error) {
      providerError = describe(error);
    }
    try {
      const session = await sessionApi.current();
      set({
        initialized: true,
        loading: false,
        providers,
        user: session?.user ?? null,
        expiresAt: session?.expiresAt ?? null,
        error: providerError,
      });
    } catch (error) {
      set({
        initialized: true,
        loading: false,
        providers,
        user: null,
        expiresAt: null,
        error: describe(error),
      });
    }
  },
  login: async () => {
    set({ loading: true, error: null });
    try {
      const session = await sessionApi.login();
      set({ user: session.user, expiresAt: session.expiresAt, loading: false });
    } catch (error) {
      set({ user: null, expiresAt: null, error: describe(error), loading: false });
    }
  },
  logout: async () => {
    try {
      await sessionApi.logout();
    } finally {
      set({ user: null, expiresAt: null, error: null });
    }
  },
}));

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const selectSessionInitialized = (state: SessionState) => state.initialized;
export const selectSessionLoading = (state: SessionState) => state.loading;
export const selectCurrentUser = (state: SessionState) => state.user;
export const selectSessionExpiresAt = (state: SessionState) => state.expiresAt;
export const selectProviders = (state: SessionState) => state.providers;
export const selectSessionError = (state: SessionState) => state.error;
export const selectInitializeSession = (state: SessionState) => state.initialize;
export const selectLogin = (state: SessionState) => state.login;
export const selectLogout = (state: SessionState) => state.logout;
