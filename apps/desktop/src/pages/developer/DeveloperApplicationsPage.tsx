import { useMemo, useState } from 'react';
import { Button, Empty, Form, Input, Message, Modal, Select, Tag } from '@arco-design/web-react';
import { IconArrowRight, IconPlus } from '@arco-design/web-react/icon';
import { useNavigate } from 'react-router-dom';

import { formatUiError, normalizeUiError } from '@/i18n/errors';
import { useLocale } from '@/i18n/localeContext';
import { developerApi } from '@/services/developerApi';
import { selectDeveloperApplication, useDeveloperStore } from '@/stores/developerStore';
import { useDeveloperContext } from './developerContext';

type ApplicationForm = {
  name: string;
  slug: string;
  summary: string;
  defaultLocale: 'en-US' | 'zh-CN';
};

export function DeveloperApplicationsPage() {
  const { applications, refreshApplications, workspaceId } = useDeveloperContext();
  const { formatDateTime, t } = useLocale();
  const navigate = useNavigate();
  const selectApplication = useDeveloperStore(selectDeveloperApplication);
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<ApplicationForm>();
  const defaultLocaleCounts = useMemo(
    () => ({
      zhCN: applications.filter((application) => application.defaultLocale === 'zh-CN').length,
      enUS: applications.filter((application) => application.defaultLocale === 'en-US').length,
    }),
    [applications],
  );

  const createApplication = async () => {
    const values = await form.validate();
    setSaving(true);
    try {
      const application = await developerApi.createApplication({
        workspaceId,
        name: values.name.trim(),
        slug: values.slug.trim(),
        summary: values.summary.trim(),
        defaultLocale: values.defaultLocale,
      });
      await refreshApplications();
      selectApplication(application.id);
      setVisible(false);
      form.resetFields();
      Message.success(t('developerPlatform.applications.created'));
      navigate('/developer/develop');
    } catch (error) {
      Message.error(formatUiError(normalizeUiError(error, 'developer_application_create_failed'), t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="developer-route developer-applications-route">
      <div className="developer-section-heading">
        <div>
          <span>{t('developerPlatform.applications.eyebrow')}</span>
          <h2>{t('developerPlatform.applications.title')}</h2>
          <p>{t('developerPlatform.applications.description')}</p>
        </div>
        <Button type="primary" icon={<IconPlus />} disabled={!workspaceId} onClick={() => setVisible(true)}>
          {t('developerPlatform.applications.create')}
        </Button>
      </div>

      <div className="developer-summary-rail">
        <SummaryCell
          index="01"
          value={applications.length}
          label={t('developerPlatform.applications.total')}
        />
        <SummaryCell index="02" value={defaultLocaleCounts.zhCN} label={t('locale.zhCN')} />
        <SummaryCell index="03" value={defaultLocaleCounts.enUS} label={t('locale.enUS')} />
        <div className="developer-trust-cell">
          <span>{t('developerPlatform.applications.deliveryTrust')}</span>
          <strong>SHA-256</strong>
          <small>{t('developerPlatform.applications.deliveryTrustDetail')}</small>
        </div>
      </div>

      {applications.length === 0 ? (
        <div className="surface developer-empty">
          <Empty description={t('developerPlatform.applications.empty')} />
        </div>
      ) : (
        <div className="developer-application-grid">
          {applications.map((application, index) => (
            <article key={application.id} className="developer-application-card">
              <header>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <Tag color="green">DESKTOP</Tag>
              </header>
              <h3>{application.name}</h3>
              <code>{application.slug}</code>
              <p>{application.summary}</p>
              <footer>
                <small>{formatDateTime(application.createdAt)}</small>
                <Button
                  type="text"
                  icon={<IconArrowRight />}
                  onClick={() => {
                    selectApplication(application.id);
                    navigate('/developer/develop');
                  }}
                >
                  {t('developerPlatform.applications.open')}
                </Button>
              </footer>
            </article>
          ))}
        </div>
      )}

      <Modal
        title={t('developerPlatform.applications.createTitle')}
        visible={visible}
        confirmLoading={saving}
        onCancel={() => setVisible(false)}
        onOk={() => void createApplication()}
      >
        <Form form={form} layout="vertical" initialValues={{ defaultLocale: 'zh-CN' }}>
          <Form.Item
            field="name"
            label={t('developerPlatform.applications.form.name')}
            rules={[{ required: true }]}
          >
            <Input
              maxLength={80}
              onChange={(value) => {
                if (!form.getFieldValue('slug')) form.setFieldValue('slug', slugify(value));
              }}
            />
          </Form.Item>
          <Form.Item
            field="slug"
            label={t('developerPlatform.applications.form.slug')}
            rules={[{ required: true, match: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/ }]}
          >
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item
            field="summary"
            label={t('developerPlatform.applications.form.summary')}
            rules={[{ required: true }]}
          >
            <Input.TextArea maxLength={240} showWordLimit autoSize={{ minRows: 3, maxRows: 5 }} />
          </Form.Item>
          <Form.Item field="defaultLocale" label={t('developerPlatform.applications.form.locale')}>
            <Select
              options={[
                { label: t('locale.zhCN'), value: 'zh-CN' },
                { label: t('locale.enUS'), value: 'en-US' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

function SummaryCell({ index, value, label }: { index: string; value: number; label: string }) {
  const { formatNumber } = useLocale();
  return (
    <div className="developer-summary-cell">
      <span>{index}</span>
      <strong>{formatNumber(value, { minimumIntegerDigits: 2, useGrouping: false })}</strong>
      <small>{label}</small>
    </div>
  );
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 64);
}
