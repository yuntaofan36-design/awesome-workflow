import { invoke } from '@tauri-apps/api/core';

import type { CurrentUser } from '@/types';
import { getDesktopRequestLocale } from '../i18n/requestLocale';

export type AuthProvider = {
  id: 'email' | 'password' | 'google' | 'feishu' | 'wechat';
  label: string;
  labelKey: `auth.provider.${AuthProvider['id']}`;
  protocol: 'email_otp' | 'password' | 'oidc';
  status: 'active' | 'configured' | 'disabled';
  strategy?: 'local_email_otp' | 'local_password' | 'oidc_broker';
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
    return invoke<AuthProvider[]>('desktop_auth_providers', {
      input: { locale: getDesktopRequestLocale() },
    });
  },
  current: async () => {
    requireDesktopRuntime();
    return invoke<DesktopSession | null>('desktop_session_current', {
      input: { locale: getDesktopRequestLocale() },
    });
  },
  login: async (locale: 'en-US' | 'zh-CN') => {
    requireDesktopRuntime();
    return invoke<DesktopSession>('desktop_session_login', { input: { locale } });
  },
  loginWithPassword: async (email: string, password: string, locale: 'en-US' | 'zh-CN') => {
    requireDesktopRuntime();
    return invoke<DesktopSession>('desktop_session_password_login', {
      input: { email, password, locale },
    });
  },
  logout: async () => {
    requireDesktopRuntime();
    return invoke<void>('desktop_session_logout', {
      input: { locale: getDesktopRequestLocale() },
    });
  },
};
