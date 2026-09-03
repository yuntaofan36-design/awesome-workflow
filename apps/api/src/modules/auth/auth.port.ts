import type { AuthProvider, SocialAuthProviderId, SupportedLocale } from '@awesome-workflow/contracts';

export const OIDC_AUTHORITY = Symbol('OIDC_AUTHORITY');

export type ExternalIdentity = {
  issuer: string;
  subject: string;
  email: string;
  displayName: string;
};

export interface OidcAuthorityPort {
  providers(): AuthProvider[];
  begin(input: {
    provider?: SocialAuthProviderId;
    returnTo?: string;
    uiLocales?: SupportedLocale;
  }): Promise<{ authorizationUrl: string }>;
  callback(input: {
    code: string;
    state: string;
  }): Promise<{ identity: ExternalIdentity; returnTo?: string }>;
}

export const EMAIL_DELIVERY = Symbol('EMAIL_DELIVERY');
export interface EmailDeliveryPort {
  sendLoginCode(input: {
    email: string;
    code: string;
    expiresInMinutes: number;
    locale: SupportedLocale;
  }): Promise<void>;
}

export const AUTH_RATE_LIMITER = Symbol('AUTH_RATE_LIMITER');
export interface AuthRateLimitPort {
  consumeEmailChallenge(input: { email: string; clientIp: string; now: Date }): Promise<void>;
  consumePasswordLogin(input: { email: string; clientIp: string; now: Date }): Promise<void>;
  consumePublicTokenExchange(input: { clientIp: string; now: Date }): Promise<void>;
}
