import { Alert, Form, Input, Modal, Select } from '@arco-design/web-react';
import type { ApplicationLocalizations, SupportedLocale } from '@awesome-workflow/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { createWebApplication } from '../api/applications';
import type { Identity, Notify } from '../controlPlaneTypes';
import { useControlPlaneI18n } from '../i18n';
import '../styles/arco-applications.less';
import '../styles/arco-form-controls.less';

export default function RegisterApplicationModal({
  identity,
  notify,
  onChanged,
  onClose,
}: {
  identity: Identity;
  notify: Notify;
  onChanged: () => Promise<unknown>;
  onClose: () => void;
}) {
  const { locale, t, translateError } = useControlPlaneI18n();
  const [form] = Form.useForm<ApplicationForm>();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (values: ApplicationForm) =>
      createWebApplication({
        defaultLocale: values.defaultLocale,
        localizations: applicationLocalizations(values),
        name: values.name,
        slug: values.slug,
        summary: values.summary,
        workspaceId: identity.workspace.id,
        locale: locale.locale,
      }),
    onSuccess: async () => {
      notify(t('applications.registeredNotice'));
      await queryClient.invalidateQueries({ queryKey: ['applications', identity.workspace.id] });
      await onChanged();
      onClose();
    },
  });

  return (
    <Modal
      title={t('applications.form.title')}
      visible
      confirmLoading={mutation.isPending}
      onCancel={onClose}
      onOk={async () => mutation.mutate(await form.validate())}
    >
      {mutation.isError && <Alert type="error" content={translateError(mutation.error)} />}
      <Form form={form} initialValues={{ defaultLocale: locale.locale }} layout="vertical">
        <Form.Item
          field="defaultLocale"
          label={t('applications.form.defaultLocale')}
          rules={[{ required: true }]}
        >
          <Select
            options={[
              { label: t('locale.enUS'), value: 'en-US' },
              { label: t('locale.zhCN'), value: 'zh-CN' },
            ]}
          />
        </Form.Item>
        <Form.Item field="name" label={t('applications.form.defaultName')} rules={[{ required: true }]}>
          <Input placeholder={t('applications.form.namePlaceholder')} />
        </Form.Item>
        <Form.Item
          field="slug"
          label={t('applications.form.slug')}
          rules={[{ required: true, match: /^[a-z][a-z0-9-]+$/ }]}
        >
          <Input placeholder={t('applications.form.slugPlaceholder')} />
        </Form.Item>
        <Form.Item field="summary" label={t('applications.form.defaultSummary')} rules={[{ required: true }]}>
          <Input.TextArea placeholder={t('applications.form.summaryPlaceholder')} />
        </Form.Item>
        <div className="cp-form-section">
          <strong>{t('applications.form.translations')}</strong>
          <small>{t('applications.form.translationsDescription')}</small>
        </div>
        <div className="cp-localized-fields">
          <Form.Item field="enUSName" label={t('applications.form.enUSName')}>
            <Input allowClear />
          </Form.Item>
          <Form.Item field="enUSSummary" label={t('applications.form.enUSSummary')}>
            <Input.TextArea allowClear />
          </Form.Item>
          <Form.Item field="zhCNName" label={t('applications.form.zhCNName')}>
            <Input allowClear />
          </Form.Item>
          <Form.Item field="zhCNSummary" label={t('applications.form.zhCNSummary')}>
            <Input.TextArea allowClear />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}

type ApplicationForm = {
  defaultLocale: SupportedLocale;
  enUSName?: string;
  enUSSummary?: string;
  name: string;
  slug: string;
  summary: string;
  zhCNName?: string;
  zhCNSummary?: string;
};

function applicationLocalizations(values: ApplicationForm): ApplicationLocalizations {
  const enUS = compactLocalizedContent(values.enUSName, values.enUSSummary);
  const zhCN = compactLocalizedContent(values.zhCNName, values.zhCNSummary);
  return {
    ...(enUS ? { 'en-US': enUS } : {}),
    ...(zhCN ? { 'zh-CN': zhCN } : {}),
  };
}

function compactLocalizedContent(
  name: string | undefined,
  summary: string | undefined,
): { name?: string; summary?: string } | undefined {
  const normalizedName = name?.trim();
  const normalizedSummary = summary?.trim();
  if (!normalizedName && !normalizedSummary) return undefined;
  return {
    ...(normalizedName ? { name: normalizedName } : {}),
    ...(normalizedSummary ? { summary: normalizedSummary } : {}),
  };
}
