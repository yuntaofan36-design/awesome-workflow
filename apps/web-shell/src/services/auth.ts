import type { AuthProvider } from '@awesome-workflow/contracts';
import type { UserSummary } from '@awesome-workflow/web-sdk';

import { apiRequest } from './http';

export type { AuthProvider } from '@awesome-workflow/contracts';

export type EmailChallenge = {
  challengeId: string;
  devCode?: string;
  expiresAt: string;
  retryAfterSeconds: number;
};

export async function getSession(): Promise<UserSummary> {
  return unwrap(await apiRequest<{ data: UserSummary }>('/auth/session'));
}

export async function getProviders(): Promise<AuthProvider[]> {
  return unwrap(await apiRequest<{ data: AuthProvider[] }>('/auth/providers'));
}

export async function startEmailChallenge(email: string): Promise<EmailChallenge> {
  return unwrap(
    await apiRequest<{ data: EmailChallenge }>('/auth/email/challenges', {
      body: JSON.stringify({ email }),
      method: 'POST',
    }),
  );
}

export async function verifyEmailChallenge(challengeId: string, code: string): Promise<UserSummary> {
  return unwrap(
    await apiRequest<{ data: UserSummary }>('/auth/email/verify', {
      body: JSON.stringify({ challengeId, code }),
      method: 'POST',
    }),
  );
}

export async function beginProviderAuthentication(provider: AuthProvider, returnTo: string): Promise<string> {
  if (provider.protocol !== 'oidc' || provider.status !== 'active') {
    throw new Error(`${provider.label} is not available for OIDC authentication`);
  }
  const query = new URLSearchParams({ returnTo });
  if (provider.id !== 'email') query.set('provider', provider.id);
  const result = unwrap(
    await apiRequest<{ data: { authorizationUrl: string } }>(`/auth/oidc/start?${query.toString()}`),
  );
  return result.authorizationUrl;
}

export async function logout(): Promise<void> {
  await apiRequest('/auth/logout', { method: 'POST' });
}

function unwrap<T>(response: { data: T }): T {
  return response.data;
}
