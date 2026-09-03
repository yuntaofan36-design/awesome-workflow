import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { Button, Select, Spin } from '@arco-design/web-react';

import { providerLabel, providerStatusLabel } from '@/i18n/domain';
import { formatUiError } from '@/i18n/errors';
import { useLocale } from '@/i18n/localeContext';
import {
  selectCurrentUser,
  selectInitializeSession,
  selectLogin,
  selectProviders,
  selectSessionError,
  selectSessionInitialized,
  selectSessionLoading,
  useSessionStore,
} from '@/stores/sessionStore';
import { LocaleSyncStatus } from './LocaleSyncStatus';

type AuthGateProps = {
  children: ReactNode;
};

export function AuthGate({ children }: AuthGateProps) {
  const { t } = useLocale();
  const initialized = useSessionStore(selectSessionInitialized);
  const currentUser = useSessionStore(selectCurrentUser);
  const loading = useSessionStore(selectSessionLoading);
  const initialize = useSessionStore(selectInitializeSession);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  if (!initialized) {
    return (
      <div className="boot-screen">
        <Spin size={32} />
        <span>{t('auth.starting')}</span>
      </div>
    );
  }

  if (!currentUser) return <DesktopLogin loading={loading} />;

  return children;
}

function DesktopLogin({ loading }: { loading: boolean }) {
  const { preference, setPreference, snapshot, t } = useLocale();
  const providers = useSessionStore(selectProviders);
  const error = useSessionStore(selectSessionError);
  const login = useSessionStore(selectLogin);
  const activeProviders = providers.filter((provider) => provider.status === 'active');
  const canLogin = activeProviders.length > 0;
  const emailOnly = activeProviders.length === 1 && activeProviders[0]?.protocol === 'email_otp';

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
          <h2>{t('auth.title')}</h2>
          <p className="muted">{t('auth.description')}</p>
          <div className="desktop-browser-login">
            {error && <div className="form-error">{formatUiError(error, t)}</div>}
            {!error && !canLogin && <div className="form-error">{t('auth.noProvider')}</div>}
            <Button
              type="primary"
              size="large"
              loading={loading}
              disabled={!canLogin}
              long
              onClick={() => void login(snapshot.locale)}
            >
              {emailOnly ? t('auth.continueEmail') : t('auth.continueBrowser')}
            </Button>
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
