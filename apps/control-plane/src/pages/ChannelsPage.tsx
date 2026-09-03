import { Skeleton, Tag } from '@arco-design/web-react';
import { SectionIntro } from '@awesome-workflow/ui';

import { CHANNELS, type CatalogMatrix } from '../controlPlaneTypes';
import type { ReleaseChannel } from '../domain';
import { useControlPlaneI18n } from '../i18n';
import '../styles/arco-data.less';

export default function ChannelsPage({ matrix, pending }: { matrix: CatalogMatrix; pending: boolean }) {
  const { formatNumber, localizeContent, t } = useControlPlaneI18n();
  return (
    <>
      <SectionIntro
        eyebrow={t('channels.eyebrow')}
        title={
          <>
            {t('channels.titleLead')} <em>{t('channels.titleEmphasis')}</em>
          </>
        }
        description={t('channels.description')}
      />
      <div className="cp-channel-grid">
        {CHANNELS.map((channel, index) => (
          <section className="cp-channel" key={channel}>
            <header>
              <span>0{index + 1}</span>
              <ChannelTag channel={channel} />
              <strong>{formatNumber(matrix[channel].length)}</strong>
            </header>
            {pending ? (
              <Skeleton animation text={{ rows: 4 }} />
            ) : matrix[channel].length === 0 ? (
              <div className="cp-channel__empty">{t('channels.empty')}</div>
            ) : (
              matrix[channel].map((entry) => {
                const content = localizeContent(entry, entry.localizations, entry.defaultLocale);
                return (
                  <article key={entry.releaseId} title={content.summary}>
                    <div>
                      <strong>{content.name}</strong>
                      <small>{entry.slug}</small>
                    </div>
                    <code>{entry.version}</code>
                  </article>
                );
              })
            )}
          </section>
        ))}
      </div>
    </>
  );
}

function ChannelTag({ channel }: { channel: ReleaseChannel }) {
  const { t } = useControlPlaneI18n();
  const color = channel === 'stable' ? 'green' : channel === 'canary' ? 'orange' : 'gray';
  return (
    <Tag bordered color={color}>
      {t(`enums.channel.${channel}`)}
    </Tag>
  );
}
