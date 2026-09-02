import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import type { AuthProvider, AuthProviderId } from '@awesome-workflow/contracts';
import { CONFIG, type PlatformConfig } from '@awesome-workflow/config';

import { DomainError, invalidState } from '../../core/errors.js';
import { PLATFORM_REPOSITORY, type PlatformRepository } from '../../core/repository.js';
import type { ExternalIdentity, OidcAuthorityPort } from './auth.port.js';

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

@Injectable()
export class LogtoOidcAdapter implements OidcAuthorityPort {
  private discoveryPromise?: Promise<Discovery>;

  constructor(
    @Inject(CONFIG) private readonly config: PlatformConfig,
    @Inject(PLATFORM_REPOSITORY) private readonly repository: PlatformRepository,
  ) {}

  providers(): AuthProvider[] {
    const start = new URL('/api/v1/auth/oidc/start', this.config.API_PUBLIC_URL).toString();
    return [
      {
        id: 'email',
        label: 'Email verification code',
        protocol: 'oidc',
        status: 'active',
        strategy: 'oidc_broker',
        authorizeUrl: start,
      },
      this.socialProvider('google', 'Google', `${start}?provider=google`),
      this.socialProvider('feishu', 'Feishu', `${start}?provider=feishu`),
      this.socialProvider('wechat', 'WeChat', `${start}?provider=wechat`),
    ];
  }

  async begin(input: {
    provider?: Exclude<AuthProviderId, 'email'>;
    returnTo?: string;
  }): Promise<{ authorizationUrl: string }> {
    if (input.provider && !this.config.oidcEnabledProviders.has(input.provider)) {
      throw new DomainError(404, 'social_provider_disabled', 'The requested social provider is not enabled');
    }
    const discovery = await this.discovery();
    const returnTo = validateInternalReturnTo(input.returnTo);
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const nonce = randomUUID();
    await this.repository.createOidcTransaction({
      id: randomUUID(),
      stateHash: hash(state),
      codeVerifier,
      nonce,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(returnTo ? { returnTo } : {}),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.OIDC_CLIENT_ID!);
    url.searchParams.set('redirect_uri', this.config.OIDC_REDIRECT_URI!);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', hashBase64Url(codeVerifier));
    if (input.provider) url.searchParams.set('direct_sign_in', `social:${input.provider}`);
    return { authorizationUrl: url.toString() };
  }

  async callback(input: {
    code: string;
    state: string;
  }): Promise<{ identity: ExternalIdentity; returnTo?: string }> {
    const transaction = await this.repository.consumeOidcTransaction(hash(input.state), new Date());
    const discovery = await this.discovery();
    const response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: this.config.OIDC_REDIRECT_URI!,
        client_id: this.config.OIDC_CLIENT_ID!,
        client_secret: this.config.OIDC_CLIENT_SECRET!,
        code_verifier: transaction.codeVerifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) invalidState('The identity broker rejected the authorization code');
    const tokens = (await response.json()) as { id_token?: string };
    const idToken = tokens.id_token;
    if (!idToken)
      throw new DomainError(409, 'invalid_state', 'The identity broker did not return an ID token');
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const verified = await jwtVerify(idToken, jwks, {
      issuer: discovery.issuer,
      audience: this.config.OIDC_CLIENT_ID!,
    });
    if (verified.payload.nonce !== transaction.nonce)
      invalidState('The identity token nonce does not match the authorization request');
    const email =
      typeof verified.payload.email === 'string' ? verified.payload.email.trim().toLowerCase() : undefined;
    if (!email || verified.payload.email_verified !== true)
      throw new DomainError(409, 'invalid_state', 'A verified email is required');
    const subject = verified.payload.sub;
    if (!subject) throw new DomainError(409, 'invalid_state', 'The identity token is missing its subject');
    const displayName =
      typeof verified.payload.name === 'string' && verified.payload.name.trim()
        ? verified.payload.name.trim()
        : email.split('@')[0] || 'Developer';
    return {
      identity: { issuer: discovery.issuer, subject, email, displayName },
      ...(transaction.returnTo ? { returnTo: transaction.returnTo } : {}),
    };
  }

  private socialProvider(
    id: Exclude<AuthProviderId, 'email'>,
    label: string,
    authorizeUrl: string,
  ): AuthProvider {
    const enabled = this.config.oidcEnabledProviders.has(id);
    return {
      id,
      label,
      protocol: 'oidc',
      status: enabled ? 'active' : 'disabled',
      strategy: 'oidc_broker',
      ...(enabled ? { authorizeUrl } : {}),
    };
  }

  private async discovery(): Promise<Discovery> {
    this.discoveryPromise ??= fetch(logtoDiscoveryUrl(this.config.OIDC_ISSUER!), {
      signal: AbortSignal.timeout(10_000),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`OIDC discovery failed with status ${response.status}`);
      const discovery = (await response.json()) as Discovery;
      if (discovery.issuer !== this.config.OIDC_ISSUER) {
        throw new Error('OIDC discovery issuer does not match OIDC_ISSUER');
      }
      return discovery;
    });
    return this.discoveryPromise;
  }
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hashBase64Url = (value: string) => createHash('sha256').update(value).digest('base64url');

export function logtoDiscoveryUrl(issuer: string): URL {
  const issuerDirectory = issuer.endsWith('/') ? issuer : `${issuer}/`;
  return new URL('.well-known/openid-configuration', issuerDirectory);
}

export function validateInternalReturnTo(returnTo: string | undefined): string | undefined {
  if (returnTo === undefined) return undefined;
  if (!returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.includes('\\')) {
    throw new DomainError(400, 'invalid_return_to', 'returnTo must be a same-origin absolute path');
  }
  return returnTo;
}
