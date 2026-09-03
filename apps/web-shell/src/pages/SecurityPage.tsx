import { Alert, Button, Card, Select, Skeleton } from '@arco-design/web-react';
import { IconEmail, IconLock, IconSafe } from '@arco-design/web-react/icon';
import { SectionIntro, SignalBadge } from '@awesome-workflow/ui';
import { useQuery } from '@tanstack/react-query';

import '@arco-design/web-react/es/Card/style/css.js';
import '@arco-design/web-react/es/Select/style/css.js';
import '@arco-design/web-react/es/Skeleton/style/css.js';

import { getProviders } from '../services/auth';
import { LocalizedErrorAlert } from '../components/LocalizedErrorAlert';
import { useI18n } from '../i18n/I18nProvider';
import { selectSetThemePreference, selectThemePreference, useShellStore } from '../stores/shellStore';
import { selectUser, useUserStore } from '../stores/userStore';

export function SecurityPage() {
  const { t } = useI18n();
  const user = useUserStore(selectUser);
  const workspace = useShellStore((state) => state.workspace);
  const themePreference = useShellStore(selectThemePreference);
  const setThemePreference = useShellStore(selectSetThemePreference);
  const providers = useQuery({ queryKey: ['auth', 'providers'], queryFn: getProviders });

  return (
    <main className="shell-page security-page">
      <SectionIntro
        eyebrow={t('security.eyebrow')}
        title={
          <>
            {t('security.title')} <em>{t('security.titleEmphasis')}</em>
          </>
        }
        description={t('security.description')}
      />
      <section className="security-grid">
        <Card className="identity-card">
          <span>{t('security.currentPrincipal')}</span>
          <div className="identity-card__mark">
            <IconSafe />
          </div>
          <h2>{user?.displayName}</h2>
          <p>{user?.email}</p>
          <SignalBadge tone="success">
            {workspace ? t(`role.${workspace.role}`) : t('common.unscoped')}
          </SignalBadge>
          <dl>
            <dt>{t('security.session')}</dt>
            <dd>HttpOnly / SameSite=Lax</dd>
            <dt>{t('security.workspaceRole')}</dt>
            <dd>{workspace ? t(`role.${workspace.role}`) : t('common.none')}</dd>
            <dt>{t('security.platformRoles')}</dt>
            <dd>
              {user?.platformRoles.map((role) => t(`platformRole.${role}`)).join(', ') || t('common.none')}
            </dd>
            <dt>{t('security.microAppView')}</dt>
            <dd>{t('security.summaryOnly')}</dd>
          </dl>
        </Card>
        <div className="provider-stack">
          <div className="section-row">
            <div>
              <span>{t('security.authConnectors')}</span>
              <h2>{t('security.providerSlots')}</h2>
            </div>
            <IconLock />
          </div>
          {providers.isPending ? (
            <Skeleton animation text={{ rows: 5 }} />
          ) : providers.isError ? (
            <LocalizedErrorAlert error={providers.error} />
          ) : (
            providers.data.map((provider) => (
              <article className="provider-row" key={provider.id}>
                <div className="provider-row__glyph">
                  {provider.id === 'email' ? <IconEmail /> : t(provider.labelKey).slice(0, 1)}
                </div>
                <div>
                  <strong>{t(provider.labelKey)}</strong>
                  <small>{t(`provider.protocol.${provider.protocol}`)}</small>
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
                  {t(`provider.status.${provider.status}`)}
                </SignalBadge>
              </article>
            ))
          )}
        </div>
      </section>
      <section className="preference-row">
        <div>
          <span>{t('security.appearance')}</span>
          <strong>{t('security.hostTheme')}</strong>
          <p>{t('security.themeBroadcast')}</p>
        </div>
        <Select
          aria-label={t('security.hostTheme')}
          value={themePreference}
          onChange={setThemePreference}
          options={[
            { label: t('theme.light'), value: 'light' },
            { label: t('theme.dark'), value: 'dark' },
            { label: t('theme.system'), value: 'system' },
          ]}
        />
      </section>
      <Alert
        type="info"
        title={t('security.providerContract')}
        content={t('security.providerContractBody')}
      />
      <Button className="security-backup" disabled>
        {t('security.recoveryCodes')}
      </Button>
    </main>
  );
}
