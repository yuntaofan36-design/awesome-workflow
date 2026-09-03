import { Badge, Button, Space } from '@arco-design/web-react';

import { formatUiError } from '@/i18n/errors';
import { useLocale } from '@/i18n/localeContext';

export function LocaleSyncStatus() {
  const { agentLocaleSync, retryAgentLocaleSync, t } = useLocale();
  const label = t(`locale.agentStatus.${agentLocaleSync.status}`);
  const status =
    agentLocaleSync.status === 'error'
      ? 'warning'
      : agentLocaleSync.status === 'syncing'
        ? 'processing'
        : 'success';

  return (
    <span role="status">
      <Space size={6}>
        <Badge
          status={status}
          text={label}
          title={agentLocaleSync.error ? formatUiError(agentLocaleSync.error, t) : label}
        />
        {agentLocaleSync.error && (
          <Button size="mini" type="text" onClick={retryAgentLocaleSync}>
            {t('locale.retryAgentSync')}
          </Button>
        )}
      </Space>
    </span>
  );
}
