import { Alert } from '@arco-design/web-react';

import { localizeError } from '../i18n/errors';
import { useI18n } from '../i18n/I18nProvider';

export function LocalizedErrorAlert({
  className,
  error,
  fallbackKey,
  title,
}: {
  className?: string;
  error: unknown;
  fallbackKey?: string;
  title?: string;
}) {
  const { t } = useI18n();
  const presentation = localizeError(error, t, fallbackKey);
  return (
    <Alert
      className={className}
      type="error"
      title={title}
      content={
        <div>
          <div>{presentation.message}</div>
          {presentation.detail && (
            <details>
              <summary>{t('common.diagnostics')}</summary>
              <code>{presentation.detail}</code>
            </details>
          )}
        </div>
      }
    />
  );
}
