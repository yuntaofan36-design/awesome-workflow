import { create } from 'zustand';

import { normalizeUiError, type UiError } from '@/i18n/errors';
import { sessionApi, type AuthProvider } from '@/services/session';
import type { CurrentUser } from '@/types';

type SessionState = {
  initialized: boolean;
  loading: boolean;
  user: CurrentUser | null;
  expiresAt: string | null;
  providers: AuthProvider[];
  error: UiError | null;
  initialize: () => Promise<void>;
  login: (locale: 'en-US' | 'zh-CN') => Promise<void>;
  loginWithPassword: (email: string, password: string, locale: 'en-US' | 'zh-CN') => Promise<void>;
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
    let providerError: UiError | null = null;
    try {
      providers = await sessionApi.providers();
    } catch (error) {
      providerError = normalizeUiError(error, 'auth_providers_failed');
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
        error: normalizeUiError(error, 'session_restore_failed'),
      });
    }
  },
  login: async (locale) => {
    set({ loading: true, error: null });
    try {
      const session = await sessionApi.login(locale);
      set({ user: session.user, expiresAt: session.expiresAt, loading: false });
    } catch (error) {
      set({
        user: null,
        expiresAt: null,
        error: normalizeUiError(error, 'sign_in_failed'),
        loading: false,
      });
    }
  },
  loginWithPassword: async (email, password, locale) => {
    set({ loading: true, error: null });
    try {
      const session = await sessionApi.loginWithPassword(email, password, locale);
      set({ user: session.user, expiresAt: session.expiresAt, loading: false });
    } catch (error) {
      set({
        user: null,
        expiresAt: null,
        error: normalizeUiError(error, 'sign_in_failed'),
        loading: false,
      });
    }
  },
  logout: async () => {
    try {
      await sessionApi.logout();
      set({ user: null, expiresAt: null, error: null });
    } catch (error) {
      set({
        user: null,
        expiresAt: null,
        error: normalizeUiError(error, 'sign_out_failed'),
      });
    }
  },
}));

export const selectSessionInitialized = (state: SessionState) => state.initialized;
export const selectSessionLoading = (state: SessionState) => state.loading;
export const selectCurrentUser = (state: SessionState) => state.user;
export const selectSessionExpiresAt = (state: SessionState) => state.expiresAt;
export const selectProviders = (state: SessionState) => state.providers;
export const selectSessionError = (state: SessionState) => state.error;
export const selectInitializeSession = (state: SessionState) => state.initialize;
export const selectLogin = (state: SessionState) => state.login;
export const selectLoginWithPassword = (state: SessionState) => state.loginWithPassword;
export const selectLogout = (state: SessionState) => state.logout;
