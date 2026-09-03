import { Alert, Button, Card, Table, Tag } from '@arco-design/web-react';
import { IconPlus } from '@arco-design/web-react/icon';
import type { Application } from '@awesome-workflow/contracts';
import { MetricCard, SectionIntro } from '@awesome-workflow/ui';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useMemo, useState } from 'react';

import { listApplications } from '../api/applications';
import type { CatalogMatrix, Identity, Notify } from '../controlPlaneTypes';
import type { CatalogEntry } from '../domain';
import { useControlPlaneI18n } from '../i18n';
import '../styles/arco-data.less';

const loadRegisterApplicationModal = () => import('../components/RegisterApplicationModal');
const RegisterApplicationModal = lazy(loadRegisterApplicationModal);
const warmRegisterApplicationModal = () => {
  void loadRegisterApplicationModal().catch(() => undefined);
};

export default function ApplicationsPage({
  identity,
  matrix,
  notify,
  onChanged,
  pending,
}: {
  identity: Identity;
  matrix: CatalogMatrix;
  notify: Notify;
  onChanged: () => Promise<unknown>;
  pending: boolean;
}) {
  const { formatDateTime, formatNumber, locale, t, translateError } = useControlPlaneI18n();
  const [open, setOpen] = useState(false);
  const applications = useQuery({
    queryKey: ['applications', identity.workspace.id, locale.locale],
    queryFn: () => listApplications(identity.workspace.id, locale.locale),
  });
  const promotedApplications = useMemo(() => uniqueApplications(matrix), [matrix]);

  return (
    <>
      <SectionIntro
        eyebrow={t('applications.eyebrow')}
        title={
          <>
            {t('applications.titleLead')} <em>{t('applications.titleEmphasis')}</em>
          </>
        }
        description={t('applications.description')}
        action={
          <Button
            type="primary"
            icon={<IconPlus />}
            onClick={() => setOpen(true)}
            onFocus={warmRegisterApplicationModal}
            onPointerEnter={warmRegisterApplicationModal}
          >
            {t('applications.register')}
          </Button>
        }
      />
      <div className="cp-metrics">
        <MetricCard
          label={t('applications.metrics.registered')}
          value={formatNumber(applications.data?.length ?? 0)}
          detail={t('applications.metrics.registeredDetail')}
        />
        <MetricCard
          label={t('applications.metrics.federation')}
          value={formatNumber(
            promotedApplications.filter((item) => item.manifest.runtime === 'federation').length,
          )}
          detail={t('applications.metrics.federationDetail')}
        />
        <MetricCard
          label={t('applications.metrics.isolated')}
          value={formatNumber(
            promotedApplications.filter((item) => item.manifest.runtime === 'iframe').length,
          )}
          detail={t('applications.metrics.isolatedDetail')}
        />
        <MetricCard
          label={t('applications.metrics.stable')}
          value={formatNumber(matrix.stable.length)}
          detail={t('applications.metrics.stableDetail')}
        />
      </div>
      {applications.isError && (
        <Alert className="cp-alert-inline" type="error" content={translateError(applications.error)} />
      )}
      <Card className="cp-table-card" bordered={false}>
        <Table
          loading={applications.isPending || pending}
          rowKey="id"
          pagination={false}
          data={applications.data ?? []}
          noDataElement={<div className="cp-empty-inline">{t('applications.empty')}</div>}
          columns={[
            {
              title: t('table.application'),
              render: (_, row: Application) => <RegisteredApplicationIdentity application={row} />,
            },
            {
              title: t('table.kind'),
              render: (_, row: Application) => <Tag bordered>{t(`enums.applicationKind.${row.kind}`)}</Tag>,
            },
            {
              title: t('table.stable'),
              render: (_, row: Application) => {
                const stable = matrix.stable.find((entry) => entry.applicationId === row.id);
                return stable ? <code>{stable.version}</code> : t('applications.notPromoted');
              },
            },
            {
              title: t('table.created'),
              render: (_, row: Application) => formatDateTime(row.createdAt),
            },
          ]}
        />
      </Card>

      {open && (
        <Suspense fallback={null}>
          <RegisterApplicationModal
            identity={identity}
            notify={notify}
            onChanged={onChanged}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}

function RegisteredApplicationIdentity({ application }: { application: Application }) {
  const { localizeContent } = useControlPlaneI18n();
  const content = localizeContent(application, application.localizations, application.defaultLocale);
  return (
    <div className="cp-app-id">
      <strong>{content.name}</strong>
      <small className="cp-app-id__summary">{content.summary}</small>
      <span className="cp-block-id">{application.slug}</span>
    </div>
  );
}

function uniqueApplications(matrix: CatalogMatrix): CatalogEntry[] {
  const entries = [...matrix.stable, ...matrix.canary, ...matrix.dev];
  return [...new Map(entries.map((entry) => [entry.applicationId, entry])).values()];
}
