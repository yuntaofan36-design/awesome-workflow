import { Alert, Button, Form, Input, Message } from '@arco-design/web-react';
import { IconEmail, IconLeft, IconLock, IconRight } from '@arco-design/web-react/icon';
import { PlatformMark, SignalBadge } from '@awesome-workflow/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import {
  beginProviderAuthentication,
  getProviders,
  startEmailChallenge,
  verifyEmailChallenge,
  type AuthProvider,
  type EmailChallenge,
} from '../services/auth';
import { selectSetAuthenticated, useUserStore } from '../stores/userStore';

const providerFallback = [
  { id: 'email', label: 'Email verification code', protocol: 'email_otp', status: 'active' },
  { id: 'google', label: 'Google', protocol: 'oidc', status: 'disabled' },
  { id: 'feishu', label: 'Feishu', protocol: 'oidc', status: 'disabled' },
  { id: 'wechat', label: 'WeChat', protocol: 'oidc', status: 'disabled' },
] as const;

export function LoginScreen() {
  const setAuthenticated = useUserStore(selectSetAuthenticated);
  const [email, setEmail] = useState('');
  const [challenge, setChallenge] = useState<EmailChallenge | null>(null);
  const providers = useQuery({ queryKey: ['auth', 'providers'], queryFn: getProviders });
  const startMutation = useMutation({
    mutationFn: startEmailChallenge,
    onSuccess: setChallenge,
  });
  const verifyMutation = useMutation({
    mutationFn: ({ code }: { code: string }) => {
      if (!challenge) throw new Error('Email challenge is missing');
      return verifyEmailChallenge(challenge.challengeId, code);
    },
    onSuccess: (user) => {
      setAuthenticated(user);
      Message.success(`Welcome, ${user.displayName}`);
    },
  });
  const oidcMutation = useMutation({
    mutationFn: (provider: AuthProvider) =>
      beginProviderAuthentication(provider, `${window.location.pathname}${window.location.search}`),
    onSuccess: (authorizationUrl) => window.location.assign(authorizationUrl),
  });
  const availableProviders: readonly AuthProvider[] = providers.data ?? providerFallback;
  const emailProvider = availableProviders.find((provider) => provider.id === 'email');
  const socialProviders = availableProviders.filter((provider) => provider.id !== 'email');
  const authenticationError =
    startMutation.error ?? verifyMutation.error ?? oidcMutation.error ?? providers.error;
  const usesOidcEmail = emailProvider?.protocol === 'oidc';

  return (
    <main className="login-screen">
      <section className="login-story">
        <PlatformMark />
        <div className="login-story__index">01 — IDENTITY EDGE</div>
        <h1>
          One account.
          <br />
          <em>Many runtimes.</em>
        </h1>
        <p>
          Identity ends at the host boundary. Micro-apps receive a capability-scoped user summary—never a
          credential.
        </p>
        <div className="login-story__signals">
          <SignalBadge tone="success">HttpOnly session</SignalBadge>
          <SignalBadge>provider-ready</SignalBadge>
        </div>
        <div className="login-story__grid" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      </section>

      <section className="login-panel">
        <div className="login-panel__inner">
          <p className="login-kicker">
            ACCESS / {challenge ? 'VERIFY EMAIL' : usesOidcEmail ? 'OIDC BROKER' : 'EMAIL FIRST'}
          </p>
          <h2>{challenge ? 'Check your inbox.' : 'Enter the workspace.'}</h2>
          <p className="login-help">
            {challenge
              ? `We sent a six-digit code to ${email}.`
              : usesOidcEmail
                ? 'Continue through the identity broker. The application never receives an identity-provider token.'
                : 'Email verification is active now. Standard OIDC providers are reserved below.'}
          </p>

          {authenticationError && <Alert type="error" content={authenticationError.message} />}

          {!challenge && usesOidcEmail ? (
            <Button
              type="primary"
              size="large"
              long
              loading={oidcMutation.isPending}
              disabled={!emailProvider || emailProvider.status !== 'active'}
              icon={<IconRight />}
              onClick={() => emailProvider && oidcMutation.mutate(emailProvider)}
            >
              Continue with email
            </Button>
          ) : !challenge ? (
            <Form
              layout="vertical"
              onSubmit={(values) => {
                const nextEmail = String(values.email ?? '')
                  .trim()
                  .toLowerCase();
                setEmail(nextEmail);
                startMutation.mutate(nextEmail);
              }}
            >
              <Form.Item field="email" label="Work email" rules={[{ required: true, type: 'email' }]}>
                <Input
                  size="large"
                  prefix={<IconEmail />}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </Form.Item>
              <Button
                htmlType="submit"
                type="primary"
                size="large"
                long
                loading={startMutation.isPending}
                icon={<IconRight />}
              >
                Send verification code
              </Button>
            </Form>
          ) : (
            <Form
              layout="vertical"
              initialValues={{ code: challenge.devCode ?? '' }}
              onSubmit={(values) => verifyMutation.mutate({ code: String(values.code ?? '') })}
            >
              {challenge.devCode && import.meta.env.DEV && (
                <Alert
                  type="info"
                  title="Development transport"
                  content={`Local verification code: ${challenge.devCode}`}
                />
              )}
              <Form.Item field="code" label="Six-digit code" rules={[{ required: true, match: /^\d{6}$/ }]}>
                <Input
                  size="large"
                  prefix={<IconLock />}
                  maxLength={6}
                  placeholder="000000"
                  autoComplete="one-time-code"
                />
              </Form.Item>
              <Button htmlType="submit" type="primary" size="large" long loading={verifyMutation.isPending}>
                Verify and continue
              </Button>
              <Button type="text" icon={<IconLeft />} onClick={() => setChallenge(null)}>
                Use another email
              </Button>
            </Form>
          )}

          <div className="provider-divider">
            <span>future provider slots</span>
          </div>
          <div className="provider-grid">
            {socialProviders.map((provider) => (
              <button
                key={provider.id}
                disabled={provider.status !== 'active' || oidcMutation.isPending}
                type="button"
                onClick={() => oidcMutation.mutate(provider)}
              >
                <ProviderGlyph provider={provider.id} />
                <span>{provider.label}</span>
                <small>
                  {provider.status === 'active'
                    ? 'available'
                    : provider.status === 'configured'
                      ? 'configured'
                      : 'reserved'}
                </small>
              </button>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

function ProviderGlyph({ provider }: { provider: string }) {
  return (
    <span className="provider-glyph" data-provider={provider}>
      {provider.slice(0, 1).toUpperCase()}
    </span>
  );
}
