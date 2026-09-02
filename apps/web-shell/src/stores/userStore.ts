import type { UserSummary } from '@awesome-workflow/web-sdk';
import { create } from 'zustand';

import { getSession, logout } from '../services/auth';
import { ApiError } from '../services/http';

type UserStatus = 'anonymous' | 'authenticated' | 'error' | 'idle' | 'loading';

type UserState = {
  error: string | null;
  initialize: () => Promise<void>;
  setAuthenticated: (user: UserSummary) => void;
  signOut: () => Promise<void>;
  status: UserStatus;
  user: UserSummary | null;
};

export const useUserStore = create<UserState>((set, get) => ({
  error: null,
  initialize: async () => {
    if (get().status === 'loading' || get().status === 'authenticated' || get().status === 'anonymous')
      return;
    set({ error: null, status: 'loading' });
    try {
      const user = await getSession();
      set({ status: 'authenticated', user });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        set({ status: 'anonymous', user: null });
        return;
      }
      set({
        error: error instanceof Error ? error.message : 'Session initialization failed',
        status: 'error',
        user: null,
      });
    }
  },
  setAuthenticated: (user) => set({ error: null, status: 'authenticated', user }),
  signOut: async () => {
    await logout();
    set({ status: 'anonymous', user: null });
  },
  status: 'idle',
  user: null,
}));

export const selectUser = (state: UserState) => state.user;
export const selectUserStatus = (state: UserState) => state.status;
export const selectUserError = (state: UserState) => state.error;
export const selectInitializeUser = (state: UserState) => state.initialize;
export const selectSetAuthenticated = (state: UserState) => state.setAuthenticated;
export const selectSignOut = (state: UserState) => state.signOut;
