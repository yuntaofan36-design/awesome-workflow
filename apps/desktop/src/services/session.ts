import { invoke } from '@tauri-apps/api/core';

import type { CurrentUser } from '@/types';

export type AuthProvider = {
  id: 'email' | 'google' | 'feishu' | 'wechat';
  label: string;
  protocol: 'email_otp' | 'oidc';
  status: 'active' | 'configured' | 'disabled';
  strategy?: 'local_email_otp' | 'oidc_broker';
  authorizeUrl?: string;
};

export type DesktopSession = {
  user: CurrentUser;
  expiresAt: string;
};

function requireDesktopRuntime() {
  if (!('__TAURI_INTERNALS__' in window)) {
    throw new Error('Secure sign-in requires the Awesome Workflow desktop host.');
  }
}

export const sessionApi = {
  providers: async () => {
    requireDesktopRuntime();
    return invoke<AuthProvider[]>('desktop_auth_providers');
  },
  current: async () => {
    requireDesktopRuntime();
    return invoke<DesktopSession | null>('desktop_session_current');
  },
  login: async () => {
    requireDesktopRuntime();
    return invoke<DesktopSession>('desktop_session_login');
  },
  logout: async () => {
    requireDesktopRuntime();
    return invoke<void>('desktop_session_logout');
  },
};
