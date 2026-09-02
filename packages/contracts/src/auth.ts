import { z } from 'zod';

import { PlatformRoleSchema } from './workspace.js';

export const EmailAddressSchema = z.string().trim().toLowerCase().email().max(254);
export const InternalReturnPathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) => value.startsWith('/') && !value.startsWith('//') && !value.includes('\\'),
    'returnTo must be a same-origin absolute path',
  );

export const AuthProviderIdSchema = z.enum(['email', 'google', 'feishu', 'wechat']);
export type AuthProviderId = z.infer<typeof AuthProviderIdSchema>;

export const AuthProviderSchema = z.object({
  id: AuthProviderIdSchema,
  label: z.string().min(1),
  protocol: z.enum(['email_otp', 'oidc']),
  status: z.enum(['active', 'configured', 'disabled']),
  strategy: z.enum(['local_email_otp', 'oidc_broker']).optional(),
  authorizeUrl: z.string().url().optional(),
});
export type AuthProvider = z.infer<typeof AuthProviderSchema>;

export const CurrentUserSchema = z.object({
  id: z.string().uuid(),
  email: EmailAddressSchema,
  displayName: z.string().min(1).max(120),
  platformRoles: z.array(PlatformRoleSchema).default([]),
});
export type CurrentUser = z.infer<typeof CurrentUserSchema>;

export const StartEmailChallengeInputSchema = z.object({
  email: EmailAddressSchema,
});
export type StartEmailChallengeInput = z.infer<typeof StartEmailChallengeInputSchema>;

export const StartEmailChallengeResultSchema = z.object({
  challengeId: z.string().uuid(),
  expiresAt: z.string().datetime(),
  retryAfterSeconds: z.number().int().nonnegative(),
  devCode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type StartEmailChallengeResult = z.infer<typeof StartEmailChallengeResultSchema>;

export const VerifyEmailChallengeInputSchema = z.object({
  challengeId: z.string().uuid(),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});
export type VerifyEmailChallengeInput = z.infer<typeof VerifyEmailChallengeInputSchema>;

export const AuthSessionResultSchema = z.object({
  accessToken: z.string().min(32),
  expiresAt: z.string().datetime(),
  user: CurrentUserSchema,
});
export type AuthSessionResult = z.infer<typeof AuthSessionResultSchema>;

export const DESKTOP_PUBLIC_CLIENT_ID = 'awesome-workflow-desktop' as const;
export const DESKTOP_OFFLINE_SCOPE = 'openid profile email offline_access' as const;

export const OidcAuthorizationInputSchema = z.object({
  provider: AuthProviderIdSchema.exclude(['email']).optional(),
  returnTo: InternalReturnPathSchema.optional(),
});
export type OidcAuthorizationInput = z.infer<typeof OidcAuthorizationInputSchema>;

export const OidcAuthorizationResultSchema = z.object({
  authorizationUrl: z.string().url(),
});
export type OidcAuthorizationResult = z.infer<typeof OidcAuthorizationResultSchema>;

const PkceValueSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const LoopbackRedirectUriSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    const port = Number(url.port);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535 &&
      url.pathname === '/callback' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, 'redirectUri must be an exact ephemeral IPv4 loopback callback');

export const CliAuthorizationInputSchema = z.object({
  redirectUri: LoopbackRedirectUriSchema,
  codeChallenge: PkceValueSchema,
  codeChallengeMethod: z.literal('S256'),
  scope: z.literal(DESKTOP_OFFLINE_SCOPE).optional(),
  state: z
    .string()
    .min(32)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export type CliAuthorizationInput = z.infer<typeof CliAuthorizationInputSchema>;

export const CliAuthorizationResultSchema = z.object({ authorizationUrl: z.string().url() });
export const CliTokenInputSchema = z.object({
  code: PkceValueSchema,
  codeVerifier: PkceValueSchema,
  redirectUri: LoopbackRedirectUriSchema,
});
export type CliTokenInput = z.infer<typeof CliTokenInputSchema>;

export const CliSessionResultSchema = AuthSessionResultSchema.extend({
  refreshToken: z.string().min(43).max(16_384).optional(),
  tokenType: z.literal('Bearer'),
});
export type CliSessionResult = z.infer<typeof CliSessionResultSchema>;

export const CliRefreshTokenInputSchema = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string().min(43).max(16_384),
  client_id: z.literal(DESKTOP_PUBLIC_CLIENT_ID),
});
export type CliRefreshTokenInput = z.infer<typeof CliRefreshTokenInputSchema>;

export const CliRefreshTokenResultSchema = z.object({
  access_token: z.string().min(32).max(16_384),
  refresh_token: z.string().min(43).max(16_384),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
});
export type CliRefreshTokenResult = z.infer<typeof CliRefreshTokenResultSchema>;

export const WorkloadTokenExchangeInputSchema = z.object({
  subjectToken: z.string().min(32).max(16_384),
  subjectTokenType: z.literal('urn:ietf:params:oauth:token-type:jwt'),
});
export type WorkloadTokenExchangeInput = z.infer<typeof WorkloadTokenExchangeInputSchema>;
