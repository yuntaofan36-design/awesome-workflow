import { Alert, Button, Form, Input, Message, Select } from '@arco-design/web-react';
import { IconEmail, IconLeft, IconLock, IconRight } from '@arco-design/web-react/icon';
import { PlatformMark, SignalBadge } from '@awesome-workflow/ui';
import type { LocalePreference } from '@awesome-workflow/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import {
  beginProviderAuthentication,
  getProviders,
  loginWithPassword,
  startEmailChallenge,
  verifyEmailChallenge,
  type AuthProvider,
  type EmailChallenge,
} from '../services/auth';
import { selectSetAuthenticated, useUserStore } from '../stores/userStore';
import { selectLocalePreference, selectSetLocalePreference, useShellStore } from '../stores/shellStore';
import { useI18n } from '../i18n/I18nProvider';
import { LocalizedErrorAlert } from './LocalizedErrorAlert';

const providerFallback = [
  {
    id: 'email',
    label: 'Email verification code',
    labelKey: 'auth.provider.email',
    protocol: 'email_otp',
    status: 'active',
  },
  {
    id: 'password',
    label: 'Administrator account',
    labelKey: 'auth.provider.password',
    protocol: 'password',
    status: 'disabled',
  },
  {
    id: 'google',
    label: 'Google',
    labelKey: 'auth.provider.google',
    protocol: 'oidc',
    status: 'disabled',
  },
  {
    id: 'feishu',
    label: 'Feishu',
    labelKey: 'auth.provider.feishu',
    protocol: 'oidc',
    status: 'disabled',
  },
  {
    id: 'wechat',
    label: 'WeChat',
    labelKey: 'auth.provider.wechat',
    protocol: 'oidc',
    status: 'disabled',
  },
] as const;

export function LoginScreen() {
  const { t } = useI18n();
  const localePreference = useShellStore(selectLocalePreference);
  const setLocalePreference = useShellStore(selectSetLocalePreference);
  const setAuthenticated = useUserStore(selectSetAuthenticated);
  const [email, setEmail] = useState('');
  const [challenge, setChallenge] = useState<EmailChallenge | null>(null);
  const [loginMethod, setLoginMethod] = useState<'email' | 'password'>('email');
  const providers = useQuery({ queryKey: ['auth', 'providers'], queryFn: getProviders });
  const startMutation = useMutation({
    mutationFn: startEmailChallenge,
    onSuccess: setChallenge,
  });
  const verifyMutation = useMutation({
    mutationFn: ({ code }: { code: string }) => {
      if (!challenge) throw new Error(t('auth.login.missingChallenge'));
      return verifyEmailChallenge(challenge.challengeId, code);
    },
    onSuccess: (user) => {
      setAuthenticated(user);
      Message.success(t('auth.login.welcome', { name: user.displayName }));
    },
  });
  const passwordMutation = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      loginWithPassword(email, password),
    onSuccess: (user) => {
      setAuthenticated(user);
      Message.success(t('auth.login.welcome', { name: user.displayName }));
    },
  });
  const oidcMutation = useMutation({
    mutationFn: (provider: AuthProvider) =>
      beginProviderAuthentication(provider, `${window.location.pathname}${window.location.search}`),
    onSuccess: (authorizationUrl) => window.location.assign(authorizationUrl),
  });
  const availableProviders: readonly AuthProvider[] = providers.data ?? providerFallback;
  const emailProvider = availableProviders.find((provider) => provider.id === 'email');
  const passwordProvider = availableProviders.find((provider) => provider.id === 'password');
  const socialProviders = availableProviders.filter(
    (provider) => provider.id !== 'email' && provider.id !== 'password',
  );
  const authenticationError =
    startMutation.error ??
    verifyMutation.error ??
    passwordMutation.error ??
    oidcMutation.error ??
    providers.error;
  const usesOidcEmail = emailProvider?.protocol === 'oidc';
  const usesPassword = loginMethod === 'password';

  return (
    <main className="login-screen">
      <section className="login-story">
        <PlatformMark />
        <div className="login-story__index">{t('auth.login.storyIndex')}</div>
        <h1>
          {t('auth.login.storyTitle')}
          <br />
          <em>{t('auth.login.storyEmphasis')}</em>
        </h1>
        <p>{t('auth.login.storyBody')}</p>
        <div className="login-story__signals">
          <SignalBadge tone="success">{t('auth.login.transportBadge')}</SignalBadge>
          <SignalBadge>{t('auth.login.providerBadge')}</SignalBadge>
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
          <Select
            aria-label={t('locale.label')}
            value={localePreference}
            onChange={(value) => setLocalePreference(value as LocalePreference)}
            options={[
              { label: t('locale.system'), value: 'system' },
              { label: t('locale.en-US'), value: 'en-US' },
              { label: t('locale.zh-CN'), value: 'zh-CN' },
            ]}
          />
          <p className="login-kicker">
            {usesPassword
              ? t('auth.login.adminKicker')
              : challenge
                ? t('auth.login.verifyEmailKicker')
                : usesOidcEmail
                  ? t('auth.login.oidcKicker')
                  : t('auth.login.emailFirstKicker')}
          </p>
          <h2>
            {usesPassword
              ? t('auth.login.adminSignIn')
              : challenge
                ? t('auth.login.checkInbox')
                : t('auth.login.enterWorkspace')}
          </h2>
          <p className="login-help">
            {usesPassword
              ? t('auth.login.adminHelp')
              : challenge
                ? t('auth.login.emailSent', { email })
                : usesOidcEmail
                  ? t('auth.login.oidcHelp')
                  : t('auth.login.emailHelp')}
          </p>

          {authenticationError && <LocalizedErrorAlert error={authenticationError} />}

          {usesPassword ? (
            <Form
              layout="vertical"
              onSubmit={(values) =>
                passwordMutation.mutate({
                  email: String(values.email ?? '')
                    .trim()
                    .toLowerCase(),
                  password: String(values.password ?? ''),
                })
              }
            >
              <Form.Item
                field="email"
                label={t('auth.login.adminEmail')}
                rules={[{ required: true, type: 'email' }]}
              >
                <Input
                  size="large"
                  prefix={<IconEmail />}
                  placeholder={t('auth.login.passwordPlaceholder')}
                  autoComplete="username"
                />
              </Form.Item>
              <Form.Item field="password" label={t('auth.login.passwordLabel')} rules={[{ required: true }]}>
                <Input.Password
                  size="large"
                  prefix={<IconLock />}
                  placeholder={t('auth.login.enterPassword')}
                  autoComplete="current-password"
                />
              </Form.Item>
              <Button htmlType="submit" type="primary" size="large" long loading={passwordMutation.isPending}>
                {t('auth.login.adminSubmit')}
              </Button>
              <Button type="text" icon={<IconLeft />} onClick={() => setLoginMethod('email')}>
                {t('auth.login.useEmailVerification')}
              </Button>
            </Form>
          ) : !challenge && usesOidcEmail ? (
            <Button
              type="primary"
              size="large"
              long
              loading={oidcMutation.isPending}
              disabled={!emailProvider || emailProvider.status !== 'active'}
              icon={<IconRight />}
              onClick={() => emailProvider && oidcMutation.mutate(emailProvider)}
            >
              {t('auth.login.continueEmail')}
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
              <Form.Item
                field="email"
                label={t('auth.login.emailLabel')}
                rules={[{ required: true, type: 'email' }]}
              >
                <Input
                  size="large"
                  prefix={<IconEmail />}
                  placeholder={t('auth.login.emailPlaceholder')}
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
                {t('auth.login.sendCode')}
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
                  title={t('auth.login.developmentTransport')}
                  content={t('auth.login.developmentCode', { code: challenge.devCode })}
                />
              )}
              <Form.Item
                field="code"
                label={t('auth.login.codeLabel')}
                rules={[{ required: true, match: /^\d{6}$/ }]}
              >
                <Input
                  size="large"
                  prefix={<IconLock />}
                  maxLength={6}
                  placeholder="000000"
                  autoComplete="one-time-code"
                />
              </Form.Item>
              <Button htmlType="submit" type="primary" size="large" long loading={verifyMutation.isPending}>
                {t('auth.login.verifySubmit')}
              </Button>
              <Button type="text" icon={<IconLeft />} onClick={() => setChallenge(null)}>
                {t('auth.login.useAnotherEmail')}
              </Button>
            </Form>
          )}

          {!usesPassword && !challenge && (
            <Button
              type="text"
              long
              icon={<IconLock />}
              disabled={passwordProvider?.status !== 'active'}
              onClick={() => setLoginMethod('password')}
            >
              {passwordProvider?.status === 'active'
                ? t('auth.login.useAdminPassword')
                : t('auth.login.adminNotConfigured')}
            </Button>
          )}

          <div className="provider-divider">
            <span>{t('auth.login.providerSlots')}</span>
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
                <span>{t(provider.labelKey)}</span>
                <small>
                  {provider.status === 'active'
                    ? t('auth.login.providerAvailable')
                    : provider.status === 'configured'
                      ? t('auth.login.providerConfigured')
                      : t('auth.login.providerReserved')}
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
