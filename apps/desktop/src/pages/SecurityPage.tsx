import { Tag } from '@arco-design/web-react';

import '@arco-design/web-react/es/Tag/style/css.js';

import { useLocale } from '@/i18n/localeContext';

const controls = [
  ['security.controls.rendererTitle', 'security.controls.rendererCopy', 'ENFORCED'],
  ['security.controls.artifactTitle', 'security.controls.artifactCopy', 'ENFORCED'],
  ['security.controls.archiveTitle', 'security.controls.archiveCopy', 'ENFORCED'],
  ['security.controls.identityTitle', 'security.controls.identityCopy', 'ENFORCED'],
  ['security.controls.credentialTitle', 'security.controls.credentialCopy', 'ENFORCED'],
  ['security.controls.sandboxTitle', 'security.controls.sandboxCopy', 'OPEN'],
] as const;

export function SecurityPage() {
  const { t } = useLocale();
  return (
    <section className="page-stack">
      <header className="page-lead">
        <div>
          <span>06</span>
          <p>{t('security.eyebrow')}</p>
        </div>
        <h1>{t('security.title')}</h1>
        <p>{t('security.description')}</p>
      </header>
      <div className="security-grid">
        {controls.map(([titleKey, copyKey, state], index) => (
          <article className="security-control" key={titleKey}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <div>
              <h3>{t(titleKey)}</h3>
              <p>{t(copyKey)}</p>
            </div>
            <Tag color={state === 'ENFORCED' ? 'green' : 'orange'}>
              {state === 'ENFORCED' ? t('security.enforced') : t('security.open')}
            </Tag>
          </article>
        ))}
      </div>
      <article className="surface deny-card">
        <div>
          <p>{t('security.defaultPolicy')}</p>
          <h2>{t('security.denyTitle')}</h2>
        </div>
        <code>
          {t('security.denyUnknownMethod')}
          <br />
          {t('security.denyUnknownCapability')}
          <br />
          {t('security.denyExpiredLease')}
          <br />
          {t('security.denyMissingKey')}
          <br />
          {t('security.denyUnsupportedTarget')}
        </code>
      </article>
    </section>
  );
}
