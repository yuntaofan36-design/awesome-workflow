import { Alert, Progress, Tag } from '@arco-design/web-react';

import { useLocale } from '@/i18n/localeContext';
import { selectSnapshot, useDesktopStore } from '@/stores/desktopStore';

export function SchedulesPage() {
  const { formatNumber, t } = useLocale();
  const sync = useDesktopStore(selectSnapshot)?.sync;
  return (
    <section className="page-stack">
      <header className="page-lead">
        <div>
          <span>05</span>
          <p>{t('schedules.eyebrow')}</p>
        </div>
        <h1>{t('schedules.title')}</h1>
        <p>{t('schedules.description')}</p>
      </header>
      {sync?.offline && <Alert type="warning" content={t('schedules.offlineWarning')} />}
      <div className="schedule-layout">
        <article className="surface revision-card">
          <p>{t('schedules.currentRevision')}</p>
          <strong>
            {formatNumber(sync?.revision ?? 0, { minimumIntegerDigits: 4, useGrouping: false })}
          </strong>
          <Tag color={sync?.offline ? 'orange' : 'green'}>
            {sync?.offline ? t('schedules.offlineCache') : t('schedules.serverConfirmed')}
          </Tag>
          <Progress
            percent={sync?.offline ? 38 : 100}
            showText={false}
            color={sync?.offline ? '#ff9a3d' : '#c7ff3d'}
          />
        </article>
        <article className="surface schedule-contract">
          <p>{t('schedules.syncContract')}</p>
          <ol>
            <li>
              <b>01</b>
              <span>{t('schedules.steps.fetch')}</span>
            </li>
            <li>
              <b>02</b>
              <span>{t('schedules.steps.reject')}</span>
            </li>
            <li>
              <b>03</b>
              <span>{t('schedules.steps.commit')}</span>
            </li>
            <li>
              <b>04</b>
              <span>{t('schedules.steps.run')}</span>
            </li>
          </ol>
        </article>
      </div>
    </section>
  );
}
