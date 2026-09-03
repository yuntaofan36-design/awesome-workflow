import { Button } from '@arco-design/web-react';
import { IconLaunch } from '@arco-design/web-react/icon';

import type { CatalogEntry, LinkManifest } from '../types/catalog';
import { useI18n } from '../i18n/I18nProvider';

export function LinkRuntime({ entry }: { entry: CatalogEntry & { manifest: LinkManifest } }) {
  const { t } = useI18n();
  return (
    <div className="link-runtime">
      <span>{t('runtime.externalCode')}</span>
      <h2>{entry.name}</h2>
      <p>{entry.summary}</p>
      <code>{entry.manifest.url}</code>
      <Button
        type="primary"
        icon={<IconLaunch />}
        href={entry.manifest.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t('runtime.externalOpen')}
      </Button>
    </div>
  );
}
