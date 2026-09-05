import type { ReactNode } from 'react';
import { lazy, Suspense, useEffect } from 'react';
import Spin from '@arco-design/web-react/es/Spin';

import { useLocale } from '@/i18n/localeContext';
import {
  selectCurrentUser,
  selectInitializeSession,
  selectSessionInitialized,
  selectSessionLoading,
  useSessionStore,
} from '@/stores/sessionStore';

const DesktopLogin = lazy(async () => ({
  default: (await import('./DesktopLogin')).DesktopLogin,
}));

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

  if (!currentUser) {
    return (
      <Suspense
        fallback={
          <div className="boot-screen">
            <Spin size={32} />
            <span>{t('auth.starting')}</span>
          </div>
        }
      >
        <DesktopLogin loading={loading} />
      </Suspense>
    );
  }

  return children;
}
