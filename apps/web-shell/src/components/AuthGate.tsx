import { Alert, Button, Spin } from '@arco-design/web-react';
import { useEffect, type PropsWithChildren } from 'react';

import { selectInitializeUser, selectUserError, selectUserStatus, useUserStore } from '../stores/userStore';
import { apiUrl } from '../services/http';
import { LoginScreen } from './LoginScreen';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function AuthGate({ children }: PropsWithChildren) {
  const status = useUserStore(selectUserStatus);
  const error = useUserStore(selectUserError);
  const initialize = useUserStore(selectInitializeUser);
  const cliRequestId = new URLSearchParams(window.location.search).get('cliRequestId');

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    if (status === 'authenticated' && cliRequestId && UUID_PATTERN.test(cliRequestId)) {
      window.location.assign(apiUrl(`/auth/cli/approve?requestId=${encodeURIComponent(cliRequestId)}`));
    }
  }, [cliRequestId, status]);

  if (status === 'idle' || status === 'loading') {
    return (
      <div className="auth-boot">
        <span>AW / SESSION PROBE</span>
        <Spin dot tip="Establishing session…" />
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="auth-boot">
        <Alert type="error" title="Session service unavailable" content={error} />
        <Button onClick={() => void initialize()}>Retry</Button>
      </div>
    );
  }
  if (status === 'anonymous') return <LoginScreen />;
  if (cliRequestId && UUID_PATTERN.test(cliRequestId)) {
    return (
      <div className="auth-boot">
        <span>AW / DEVICE AUTHORIZATION</span>
        <Spin dot tip="Returning to the desktop app…" />
      </div>
    );
  }
  return children;
}
