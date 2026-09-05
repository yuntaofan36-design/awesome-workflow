import { lazy, Suspense, useState } from 'react';
import Button from '@arco-design/web-react/es/Button';
import Select from '@arco-design/web-react/es/Select';
import Spin from '@arco-design/web-react/es/Spin';
import { IconLock } from '@arco-design/web-react/icon';

import '@/styles/arco-auth';

import { providerLabel, providerStatusLabel } from '@/i18n/domain';
import { formatUiError } from '@/i18n/errors';
import { useLocale } from '@/i18n/localeContext';
import {
  selectLogin,
  selectLoginWithPassword,
  selectProviders,
  selectSessionError,
  useSessionStore,
} from '@/stores/sessionStore';
import { LocaleSyncStatus } from './LocaleSyncStatus';

const PasswordLoginForm = lazy(async () => ({
  default: (await import('./PasswordLoginForm')).PasswordLoginForm,
}));

export function DesktopLogin({ loading }: { loading: boolean }) {
  const { preference, setPreference, snapshot, t } = useLocale();
  const providers = useSessionStore(selectProviders);
  const error = useSessionStore(selectSessionError);
  const login = useSessionStore(selectLogin);
  const loginWithPassword = useSessionStore(selectLoginWithPassword);
  const activeProviders = providers.filter((provider) => provider.status === 'active');
  const passwordProvider = activeProviders.find((provider) => provider.protocol === 'password');
  const browserProviders = activeProviders.filter((provider) => provider.protocol !== 'password');
  const [loginMethod, setLoginMethod] = useState<'browser' | 'password'>(() =>
    browserProviders.length > 0 ? 'browser' : 'password',
  );
  const usesPassword = loginMethod === 'password' && Boolean(passwordProvider);
  const emailOnly = browserProviders.length === 1 && browserProviders[0]?.protocol === 'email_otp';

  return (
    <main className="login-screen">
      <section className="login-manifesto">
        <div className="wordmark">
          <span>AW</span> AWESOME WORKFLOW
        </div>
        <div>
          <p className="eyebrow">{t('auth.eyebrow')}</p>
          <h1>
            {t('auth.headlineLine1')}
            <br />
            <em>{t('auth.headlineLine2')}</em>
          </h1>
          <p className="login-copy">{t('auth.copy')}</p>
        </div>
        <div className="boundary-strip">
          <b>01</b> {t('auth.boundaryWebView')} <i /> <b>02</b> {t('auth.boundaryBroker')} <i /> <b>03</b>{' '}
          {t('auth.boundaryAgent')}
        </div>
      </section>
      <section className="login-panel">
        <div className="login-panel-inner">
          <Select
            aria-label={t('locale.label')}
            style={{ width: '100%' }}
            value={preference}
            onChange={(value) => {
              if (value === 'system' || value === 'en-US' || value === 'zh-CN') {
                void setPreference(value);
              }
            }}
            options={[
              { label: t('locale.system'), value: 'system' },
              { label: t('locale.enUS'), value: 'en-US' },
              { label: t('locale.zhCN'), value: 'zh-CN' },
            ]}
          />
          <LocaleSyncStatus />
          <p className="section-index">{t('auth.sectionIndex')}</p>
          <h2>{t(usesPassword ? 'auth.adminTitle' : 'auth.title')}</h2>
          <p className="muted">{t(usesPassword ? 'auth.adminDescription' : 'auth.description')}</p>
          <div className="desktop-browser-login">
            {error && <div className="form-error">{formatUiError(error, t)}</div>}
            {!error && activeProviders.length === 0 && (
              <div className="form-error">{t('auth.noProvider')}</div>
            )}
            {usesPassword ? (
              <Suspense
                fallback={
                  <div className="route-loading">
                    <Spin size={24} />
                  </div>
                }
              >
                <PasswordLoginForm
                  loading={loading}
                  showBrowserLogin={browserProviders.length > 0}
                  onSubmit={(email, password) => void loginWithPassword(email, password, snapshot.locale)}
                  onUseBrowser={() => setLoginMethod('browser')}
                />
              </Suspense>
            ) : (
              <>
                <Button
                  type="primary"
                  size="large"
                  loading={loading}
                  disabled={browserProviders.length === 0}
                  long
                  onClick={() => void login(snapshot.locale)}
                >
                  {emailOnly ? t('auth.continueEmail') : t('auth.continueBrowser')}
                </Button>
                {passwordProvider && (
                  <Button type="text" icon={<IconLock />} onClick={() => setLoginMethod('password')}>
                    {t('auth.useAdminPassword')}
                  </Button>
                )}
              </>
            )}
            <small>{t('auth.tokenBoundary')}</small>
          </div>
          <div className="provider-slots">
            {providers.map((provider) => (
              <button key={provider.id} disabled type="button">
                <span>{providerLabel(provider, t)}</span>
                <small>{providerStatusLabel(provider, t)}</small>
              </button>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
