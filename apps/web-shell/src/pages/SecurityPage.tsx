import { Alert, Button, Card, Select, Skeleton } from '@arco-design/web-react';
import { IconEmail, IconLock, IconSafe } from '@arco-design/web-react/icon';
import { SectionIntro, SignalBadge } from '@awesome-workflow/ui';
import { useQuery } from '@tanstack/react-query';

import { getProviders } from '../services/auth';
import { selectSetThemePreference, selectThemePreference, useShellStore } from '../stores/shellStore';
import { selectUser, useUserStore } from '../stores/userStore';

export function SecurityPage() {
  const user = useUserStore(selectUser);
  const workspace = useShellStore((state) => state.workspace);
  const themePreference = useShellStore(selectThemePreference);
  const setThemePreference = useShellStore(selectSetThemePreference);
  const providers = useQuery({ queryKey: ['auth', 'providers'], queryFn: getProviders });

  return (
    <main className="shell-page security-page">
      <SectionIntro
        eyebrow="System / Identity and access"
        title={
          <>
            Identity is a host concern, <em>not a micro-app secret.</em>
          </>
        }
        description="The session remains in an HttpOnly cookie. Applications receive only the stable internal user summary exposed by Host API v1."
      />
      <section className="security-grid">
        <Card className="identity-card">
          <span>CURRENT PRINCIPAL</span>
          <div className="identity-card__mark">
            <IconSafe />
          </div>
          <h2>{user?.displayName}</h2>
          <p>{user?.email}</p>
          <SignalBadge tone="success">{workspace?.role ?? 'unscoped'}</SignalBadge>
          <dl>
            <dt>Session</dt>
            <dd>HttpOnly / SameSite=Lax</dd>
            <dt>Workspace role</dt>
            <dd>{workspace?.role ?? 'none'}</dd>
            <dt>Platform roles</dt>
            <dd>{user?.platformRoles.join(', ') || 'none'}</dd>
            <dt>Micro-app view</dt>
            <dd>Summary only</dd>
          </dl>
        </Card>
        <div className="provider-stack">
          <div className="section-row">
            <div>
              <span>AUTH CONNECTORS</span>
              <h2>Provider slots</h2>
            </div>
            <IconLock />
          </div>
          {providers.isPending ? (
            <Skeleton animation text={{ rows: 5 }} />
          ) : providers.isError ? (
            <Alert type="error" content={providers.error.message} />
          ) : (
            providers.data.map((provider) => (
              <article className="provider-row" key={provider.id}>
                <div className="provider-row__glyph">
                  {provider.id === 'email' ? <IconEmail /> : provider.label.slice(0, 1)}
                </div>
                <div>
                  <strong>{provider.label}</strong>
                  <small>{provider.protocol === 'oidc' ? 'OpenID Connect' : 'Email one-time code'}</small>
                </div>
                <SignalBadge
                  tone={
                    provider.status === 'active'
                      ? 'success'
                      : provider.status === 'configured'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {provider.status}
                </SignalBadge>
              </article>
            ))
          )}
        </div>
      </section>
      <section className="preference-row">
        <div>
          <span>APPEARANCE</span>
          <strong>Host theme</strong>
          <p>Theme changes are broadcast as a safe Host API event.</p>
        </div>
        <Select
          value={themePreference}
          onChange={setThemePreference}
          options={[
            { label: 'Light', value: 'light' },
            { label: 'Dark', value: 'dark' },
            { label: 'System', value: 'system' },
          ]}
        />
      </section>
      <Alert
        type="info"
        title="Provider extension contract"
        content="Google, Feishu and WeChat will map external identities onto the same internal user ID. Business authorization remains independent from the login provider."
      />
      <Button className="security-backup" disabled>
        Recovery codes · planned
      </Button>
    </main>
  );
}
