import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

import { Inject, Injectable } from '@nestjs/common';
import type {
  AuthProvider,
  AuthSessionResult,
  CliAuthorizationInput,
  CliRefreshTokenInput,
  CliRefreshTokenResult,
  CliSessionResult,
  CliTokenInput,
  CurrentUser,
  SocialAuthProviderId,
  SupportedLocale,
  WorkloadTokenExchangeInput,
} from '@awesome-workflow/contracts';
import { CONFIG, type PlatformConfig } from '@awesome-workflow/config';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';

import { DomainError } from '../../core/errors.js';
import { PLATFORM_REPOSITORY, type PlatformRepository } from '../../core/repository.js';
import {
  AUTH_RATE_LIMITER,
  EMAIL_DELIVERY,
  OIDC_AUTHORITY,
  type AuthRateLimitPort,
  type EmailDeliveryPort,
  type OidcAuthorityPort,
} from './auth.port.js';

export const EMAIL_OTP_POLICY = Object.freeze({
  digits: 6,
  ttlMs: 5 * 60 * 1000,
  maxAttempts: 5,
  resendCooldownMs: 60 * 1000,
});
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SHORT_SESSION_TTL_MS = 60 * 60 * 1000;
const REFRESH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLI_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const scryptPassword = promisify(scrypt);

@Injectable()
export class AuthService {
  private readonly workloadKeySets = new Map<string, JWTVerifyGetKey>();
  constructor(
    @Inject(CONFIG) private readonly config: PlatformConfig,
    @Inject(PLATFORM_REPOSITORY) private readonly repository: PlatformRepository,
    @Inject(EMAIL_DELIVERY) private readonly emailDelivery: EmailDeliveryPort,
    @Inject(OIDC_AUTHORITY) private readonly oidc: OidcAuthorityPort,
    @Inject(AUTH_RATE_LIMITER) private readonly rateLimiter: AuthRateLimitPort,
  ) {}

  providers(): AuthProvider[] {
    const password = this.passwordProvider();
    if (this.config.AUTH_MODE === 'oidc') {
      const providers = this.oidc.providers();
      const email = providers.find((provider) => provider.id === 'email');
      return [
        ...(email ? [email] : []),
        password,
        ...providers.filter((provider) => provider.id !== 'email'),
      ];
    }
    const email = {
      id: 'email' as const,
      label: 'Email verification code',
      labelKey: 'auth.provider.email' as const,
      protocol: 'email_otp' as const,
      status: 'active' as const,
      strategy: 'local_email_otp' as const,
    };
    if (this.config.AUTH_MODE === 'hybrid') {
      return [email, password, ...this.oidc.providers().filter((provider) => provider.id !== 'email')];
    }
    return [
      email,
      password,
      ...(['google', 'feishu', 'wechat'] as const).map((id) => ({
        id,
        label: id[0]!.toUpperCase() + id.slice(1),
        labelKey: `auth.provider.${id}` as const,
        protocol: 'oidc' as const,
        status: 'disabled' as const,
        strategy: 'oidc_broker' as const,
      })),
    ];
  }

  async loginPassword(email: string, password: string, clientIp: string): Promise<AuthSessionResult> {
    const user = await this.authenticatePasswordAdministrator(email, password, clientIp);
    return this.issueSession(user, SESSION_TTL_MS);
  }

  async loginPasswordForCli(email: string, password: string, clientIp: string): Promise<CliSessionResult> {
    const user = await this.authenticatePasswordAdministrator(email, password, clientIp);
    return this.issueRefreshSession(user);
  }

  async requestEmailCode(
    email: string,
    clientIp: string,
    locale: SupportedLocale = 'en-US',
  ): Promise<{ challengeId: string; expiresAt: string; retryAfterSeconds: number; devCode?: string }> {
    this.requireLocalOtp();
    const normalized = email.trim().toLowerCase();
    const now = new Date();
    await this.rateLimiter.consumeEmailChallenge({ email: normalized, clientIp, now });
    const latest = await this.repository.findLatestEmailChallenge(normalized);
    if (latest && latest.createdAt.getTime() + EMAIL_OTP_POLICY.resendCooldownMs > now.getTime()) {
      throw new DomainError(
        429,
        'challenge_rate_limited',
        'Wait before requesting another verification code',
        {
          retryAfterSeconds: Math.ceil(
            (latest.createdAt.getTime() + EMAIL_OTP_POLICY.resendCooldownMs - now.getTime()) / 1000,
          ),
        },
      );
    }
    const id = randomUUID();
    const code = randomInt(0, 10 ** EMAIL_OTP_POLICY.digits)
      .toString()
      .padStart(EMAIL_OTP_POLICY.digits, '0');
    const expiresAt = new Date(now.getTime() + EMAIL_OTP_POLICY.ttlMs);
    await this.repository.createEmailChallenge({
      id,
      email: normalized,
      codeHash: this.hashOtp(id, normalized, code),
      attempts: 0,
      createdAt: now,
      expiresAt,
    });
    await this.emailDelivery.sendLoginCode({ email: normalized, code, expiresInMinutes: 5, locale });
    return {
      challengeId: id,
      expiresAt: expiresAt.toISOString(),
      retryAfterSeconds: EMAIL_OTP_POLICY.resendCooldownMs / 1000,
      ...(this.config.NODE_ENV === 'test' && this.config.AUTH_DEV_EXPOSE_OTP ? { devCode: code } : {}),
    };
  }

  async verifyEmailCode(challengeId: string, code: string): Promise<AuthSessionResult> {
    this.requireLocalOtp();
    const email = await this.consumeWithDerivedHash(challengeId, code);
    return this.completeIdentity({
      issuer: 'local-email',
      subject: email,
      email,
      displayName: email.split('@')[0] || 'Developer',
    });
  }

  async beginOidc(input: {
    provider?: SocialAuthProviderId;
    returnTo?: string;
    uiLocales?: SupportedLocale;
  }) {
    if (!['oidc', 'hybrid'].includes(this.config.AUTH_MODE))
      throw new DomainError(404, 'oidc_disabled', 'OIDC authentication is not enabled');
    if (this.config.AUTH_MODE === 'hybrid' && !input.provider) {
      throw new DomainError(400, 'social_provider_required', 'Hybrid OIDC login requires a social provider');
    }
    return this.oidc.begin(input);
  }

  async completeOidc(input: {
    code: string;
    state: string;
  }): Promise<{ session: AuthSessionResult; returnTo?: string }> {
    if (!['oidc', 'hybrid'].includes(this.config.AUTH_MODE))
      throw new DomainError(404, 'oidc_disabled', 'OIDC authentication is not enabled');
    const result = await this.oidc.callback(input);
    return {
      session: await this.completeIdentity(result.identity),
      ...(result.returnTo ? { returnTo: result.returnTo } : {}),
    };
  }

  async beginCliAuthorization(
    input: CliAuthorizationInput,
    clientIp: string,
  ): Promise<{ authorizationUrl: string }> {
    const now = new Date();
    await this.rateLimiter.consumePublicTokenExchange({ clientIp, now });
    const id = randomUUID();
    await this.repository.createCliAuthorization({
      id,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      state: input.state,
      offlineAccess: input.scope === 'openid profile email offline_access',
      createdAt: now,
      expiresAt: new Date(now.getTime() + CLI_AUTHORIZATION_TTL_MS),
    });
    const continuation = `/api/v1/auth/cli/approve?requestId=${encodeURIComponent(id)}`;
    if (this.config.AUTH_MODE === 'oidc') {
      return this.oidc.begin({ returnTo: continuation, uiLocales: input.locale });
    }
    const loginContinuation = new URL('/', this.config.WEB_PUBLIC_URL);
    loginContinuation.searchParams.set('cliRequestId', id);
    if (input.locale) loginContinuation.searchParams.set('locale', input.locale);
    return { authorizationUrl: loginContinuation.toString() };
  }

  async approveCliAuthorization(requestId: string, actor: CurrentUser): Promise<string> {
    const code = randomBytes(48).toString('base64url');
    const target = await this.repository.authorizeCliRequest(
      requestId,
      actor.id,
      this.hashCliCode(code),
      new Date(),
    );
    const redirect = new URL(target.redirectUri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', target.state);
    return redirect.toString();
  }

  async exchangeCliCode(input: CliTokenInput, clientIp: string): Promise<CliSessionResult> {
    await this.rateLimiter.consumePublicTokenExchange({ clientIp, now: new Date() });
    const codeChallenge = createHash('sha256').update(input.codeVerifier, 'ascii').digest('base64url');
    const authorization = await this.repository.consumeCliAuthorization({
      codeHash: this.hashCliCode(input.code),
      redirectUri: input.redirectUri,
      codeChallenge,
      now: new Date(),
    });
    if (authorization.offlineAccess) return this.issueRefreshSession(authorization.user);
    return { ...(await this.issueSession(authorization.user, SHORT_SESSION_TTL_MS)), tokenType: 'Bearer' };
  }

  async refreshCliToken(input: CliRefreshTokenInput, clientIp: string): Promise<CliRefreshTokenResult> {
    const now = new Date();
    await this.rateLimiter.consumePublicTokenExchange({ clientIp, now });
    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(48).toString('base64url');
    const accessExpiresAt = new Date(now.getTime() + SHORT_SESSION_TTL_MS);
    const result = await this.repository.rotateRefreshSession({
      refreshTokenHash: this.hashRefreshToken(input.refresh_token),
      nextRefreshTokenHash: this.hashRefreshToken(refreshToken),
      nextAccessTokenHash: this.hashSession(accessToken),
      nextAccessExpiresAt: accessExpiresAt,
      now,
    });
    if (result.status !== 'rotated') {
      throw new DomainError(400, 'invalid_grant', 'The refresh token is invalid or expired');
    }
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: SHORT_SESSION_TTL_MS / 1000,
    };
  }

  async exchangeWorkloadToken(
    input: WorkloadTokenExchangeInput,
    clientIp: string,
  ): Promise<AuthSessionResult> {
    await this.rateLimiter.consumePublicTokenExchange({ clientIp, now: new Date() });
    let unverified: ReturnType<typeof decodeJwt>;
    try {
      unverified = decodeJwt(input.subjectToken);
    } catch {
      throw new DomainError(401, 'invalid_workload_token', 'The workload identity token is invalid');
    }
    const policy = this.config.workloadOidcPolicies.find(
      (candidate) => candidate.issuer === unverified.iss && candidate.subject === unverified.sub,
    );
    if (!policy)
      throw new DomainError(
        401,
        'workload_not_trusted',
        'No workload trust policy matches this issuer and subject',
      );
    try {
      const keySet = this.workloadKeySets.get(policy.jwksUri) ?? createRemoteJWKSet(new URL(policy.jwksUri));
      this.workloadKeySets.set(policy.jwksUri, keySet);
      await jwtVerify(input.subjectToken, keySet, {
        issuer: policy.issuer,
        audience: policy.audience,
        algorithms: ['RS256', 'ES256', 'EdDSA'],
        clockTolerance: 5,
        maxTokenAge: '10m',
      });
    } catch {
      throw new DomainError(
        401,
        'invalid_workload_token',
        'The workload identity token failed issuer, audience, signature, or lifetime validation',
      );
    }
    const session = await this.completeIdentity(
      {
        issuer: `workload:${policy.issuer}`,
        subject: policy.subject,
        email: policy.principalEmail,
        displayName: policy.displayName,
      },
      SHORT_SESSION_TTL_MS,
    );
    return session;
  }

  async current(token: string | undefined): Promise<CurrentUser | null> {
    return token ? this.repository.findUserBySession(this.hashSession(token), new Date()) : null;
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.repository.revokeSessionFamily(this.hashSession(token), new Date());
  }

  private async consumeWithDerivedHash(challengeId: string, code: string): Promise<string> {
    // The repository performs the compare and attempt increment atomically. The email is
    // included in the HMAC, so retrieve the open challenge through a dedicated lookup.
    const challenge = await this.repository.findEmailChallengeById(challengeId);
    if (!challenge) throw new DomainError(409, 'invalid_state', 'The email challenge is invalid');
    return this.repository.consumeEmailChallenge(
      challengeId,
      this.hashOtp(challengeId, challenge.email, code),
      new Date(),
      EMAIL_OTP_POLICY.maxAttempts,
    );
  }

  private async completeIdentity(
    identity: { issuer: string; subject: string; email: string; displayName: string },
    ttlMs = SESSION_TTL_MS,
    platformRoles?: CurrentUser['platformRoles'],
  ): Promise<AuthSessionResult> {
    const effectivePlatformRoles =
      platformRoles ??
      (this.config.bootstrapAdminEmails.has(identity.email) ? (['platform_admin'] as const) : []);
    const user = await this.repository.upsertIdentity({
      ...identity,
      platformRoles: [...effectivePlatformRoles],
    });
    return this.issueSession(user, ttlMs);
  }

  private async issueSession(user: CurrentUser, ttlMs: number): Promise<AuthSessionResult> {
    const accessToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.repository.createSession(user.id, this.hashSession(accessToken), expiresAt);
    return { accessToken, expiresAt: expiresAt.toISOString(), user };
  }

  private async issueRefreshSession(user: CurrentUser): Promise<CliSessionResult> {
    const now = new Date();
    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(now.getTime() + SHORT_SESSION_TTL_MS);
    await this.repository.createRefreshSession({
      familyId: randomUUID(),
      userId: user.id,
      accessTokenHash: this.hashSession(accessToken),
      accessExpiresAt: expiresAt,
      refreshTokenHash: this.hashRefreshToken(refreshToken),
      refreshExpiresAt: new Date(now.getTime() + REFRESH_SESSION_TTL_MS),
      now,
    });
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresAt: expiresAt.toISOString(),
      user,
    };
  }

  private hashCliCode(code: string): string {
    return createHmac('sha256', this.config.SESSION_SECRET).update(`cli-code:${code}`).digest('hex');
  }

  private async authenticatePasswordAdministrator(
    email: string,
    password: string,
    clientIp: string,
  ): Promise<CurrentUser> {
    if (!this.passwordAuthenticationEnabled()) {
      throw new DomainError(404, 'password_auth_disabled', 'Administrator password login is disabled');
    }
    const normalizedEmail = email.trim().toLowerCase();
    await this.rateLimiter.consumePasswordLogin({ email: normalizedEmail, clientIp, now: new Date() });
    if (!(await this.passwordCredentialsMatch(normalizedEmail, password))) {
      throw new DomainError(401, 'invalid_credentials', 'Invalid email or password');
    }
    return this.repository.upsertIdentity({
      issuer: 'local-password-admin',
      subject: this.config.AUTH_PASSWORD_ADMIN_EMAIL!,
      email: this.config.AUTH_PASSWORD_ADMIN_EMAIL!,
      displayName: this.config.AUTH_PASSWORD_ADMIN_EMAIL!.split('@')[0] || 'admin',
      platformRoles: ['platform_admin'],
    });
  }

  private passwordProvider(): AuthProvider {
    return {
      id: 'password',
      label: 'Administrator account',
      labelKey: 'auth.provider.password',
      protocol: 'password',
      status: this.passwordAuthenticationEnabled() ? 'active' : 'disabled',
      strategy: 'local_password',
    };
  }

  private passwordAuthenticationEnabled(): boolean {
    return Boolean(this.config.AUTH_PASSWORD_ADMIN_EMAIL && this.config.AUTH_PASSWORD_ADMIN_PASSWORD);
  }

  private async passwordCredentialsMatch(email: string, password: string): Promise<boolean> {
    const emailMatches = timingSafeEqual(
      this.passwordCredentialDigest(email),
      this.passwordCredentialDigest(this.config.AUTH_PASSWORD_ADMIN_EMAIL!),
    );
    const salt = createHmac('sha256', this.config.SESSION_SECRET)
      .update(`password-admin:${this.config.AUTH_PASSWORD_ADMIN_EMAIL!}`)
      .digest();
    const [candidateHash, configuredHash] = await Promise.all([
      scryptPassword(password, salt, 64) as Promise<Buffer>,
      scryptPassword(this.config.AUTH_PASSWORD_ADMIN_PASSWORD!, salt, 64) as Promise<Buffer>,
    ]);
    const passwordMatches = timingSafeEqual(candidateHash, configuredHash);
    return emailMatches && passwordMatches;
  }

  private passwordCredentialDigest(value: string): Buffer {
    return createHmac('sha256', this.config.SESSION_SECRET).update(`password-login:${value}`).digest();
  }

  private hashOtp(challengeId: string, email: string, code: string): string {
    return createHmac('sha256', this.config.OTP_PEPPER)
      .update(`${challengeId}:${email}:${code}`)
      .digest('hex');
  }

  private hashSession(token: string): string {
    return createHmac('sha256', this.config.SESSION_SECRET).update(token).digest('hex');
  }

  private hashRefreshToken(token: string): string {
    return createHmac('sha256', this.config.SESSION_SECRET).update(`refresh-token:${token}`).digest('hex');
  }

  private requireLocalOtp(): void {
    if (!['local_otp', 'hybrid'].includes(this.config.AUTH_MODE))
      throw new DomainError(404, 'local_auth_disabled', 'BFF email OTP is not enabled');
  }
}
