import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { Button, Spin } from '@arco-design/web-react';

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

type AuthGateProps = {
  children: ReactNode;
};

export function AuthGate({ children }: AuthGateProps) {
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
        <span>Starting secure host…</span>
      </div>
    );
  }

  if (!currentUser) return <DesktopLogin loading={loading} />;

  return children;
}

function DesktopLogin({ loading }: { loading: boolean }) {
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
          <p className="eyebrow">DESKTOP HOST / SECURE SESSION</p>
          <h1>
            Run local.
            <br />
            <em>Trust less.</em>
          </h1>
          <p className="login-copy">
            A desktop micro-application host with signed artifacts, scoped leases, and a runner that never
            receives your platform credentials.
          </p>
        </div>
        <div className="boundary-strip">
          <b>01</b> WebView <i /> <b>02</b> Rust broker <i /> <b>03</b> Agent
        </div>
      </section>
      <section className="login-panel">
        <div className="login-panel-inner">
          <p className="section-index">AUTH / 001</p>
          <h2>Sign in outside the WebView</h2>
          <p className="muted">
            Continue in your system browser. Email verification happens on the platform, while the short-lived
            session stays in your OS credential store.
          </p>
          <div className="desktop-browser-login">
            {error && <div className="form-error">{error}</div>}
            {!error && !canLogin && (
              <div className="form-error">No active sign-in provider is available.</div>
            )}
            <Button
              type="primary"
              size="large"
              loading={loading}
              disabled={!canLogin}
              long
              onClick={() => void login()}
            >
              {emailOnly ? 'Continue with email' : 'Continue in browser'}
            </Button>
            <small>The WebView never receives or persists the access token.</small>
          </div>
          <div className="provider-slots">
            {providers.map((provider) => (
              <button key={provider.id} disabled type="button">
                <span>{provider.label}</span>
                <small>{provider.status}</small>
              </button>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
