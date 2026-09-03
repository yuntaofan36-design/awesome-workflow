import { Button, Spin } from '@arco-design/web-react';
import { lazy, Suspense, useEffect, type PropsWithChildren } from 'react';

import { selectInitializeUser, selectUserError, selectUserStatus, useUserStore } from '../stores/userStore';
import { apiUrl } from '../services/http';
import { useI18n } from '../i18n/I18nProvider';
import { LocalizedErrorAlert } from './LocalizedErrorAlert';

const LoginScreen = lazy(async () => {
  const module = await import('./LoginScreen');
  return { default: module.LoginScreen };
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function AuthGate({ children }: PropsWithChildren) {
  const { t } = useI18n();
  const status = useUserStore(selectUserStatus);
  const error = useUserStore(selectUserError);
  const initialize = useUserStore(selectInitializeUser);
  const cliRequestId = new URLSearchParams(window.location.search).get('cliRequestId');

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    if (status !== 'authenticated') document.title = t('app.title');
  }, [status, t]);

  useEffect(() => {
    if (status === 'authenticated' && cliRequestId && UUID_PATTERN.test(cliRequestId)) {
      window.location.assign(apiUrl(`/auth/cli/approve?requestId=${encodeURIComponent(cliRequestId)}`));
    }
  }, [cliRequestId, status]);

  if (status === 'idle' || status === 'loading') {
    return (
      <div className="auth-boot">
        <span>{t('auth.boot.sessionProbe')}</span>
        <Spin dot tip={t('auth.boot.sessionWorking')} />
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="auth-boot">
        <LocalizedErrorAlert error={error} title={t('auth.boot.sessionUnavailable')} />
        <Button onClick={() => void initialize()}>{t('common.retry')}</Button>
      </div>
    );
  }
  if (status === 'anonymous') {
    return (
      <Suspense
        fallback={
          <div className="auth-boot">
            <Spin dot tip={t('auth.boot.sessionWorking')} />
          </div>
        }
      >
        <LoginScreen />
      </Suspense>
    );
  }
  if (cliRequestId && UUID_PATTERN.test(cliRequestId)) {
    return (
      <div className="auth-boot">
        <span>{t('auth.boot.deviceAuthorization')}</span>
        <Spin dot tip={t('auth.boot.deviceReturning')} />
      </div>
    );
  }
  return children;
}
