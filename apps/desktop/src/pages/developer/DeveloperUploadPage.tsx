import { useState } from 'react';
import { Alert, Button, Empty, Input, Message, Progress, Steps, Tag } from '@arco-design/web-react';
import { IconCheckCircle, IconFile, IconLaunch, IconUpload } from '@arco-design/web-react/icon';
import { useNavigate } from 'react-router-dom';

import { formatUiError, normalizeUiError } from '@/i18n/errors';
import { useLocale } from '@/i18n/localeContext';
import { developerApi, type DesktopPublishResult } from '@/services/developerApi';
import { desktopHost } from '@/services/desktopHost';
import { useDeveloperContext } from './developerContext';

type UploadPhase = 'idle' | 'reading' | 'uploading' | 'submitted' | 'error';

export function DeveloperUploadPage() {
  const { selectedApplication } = useDeveloperContext();
  const { t } = useLocale();
  const navigate = useNavigate();
  const [metadataPath, setMetadataPath] = useState('');
  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [result, setResult] = useState<DesktopPublishResult | null>(null);

  if (!selectedApplication) {
    return (
      <div className="surface developer-empty">
        <Empty description={t('developerPlatform.chooseApplicationFirst')} />
      </div>
    );
  }

  const chooseMetadata = async () => {
    const selected = await desktopHost.choosePackageMetadata(
      t('developerPlatform.upload.chooseMetadata'),
      t('developerPlatform.upload.metadataFilter'),
    );
    if (selected) {
      setMetadataPath(selected);
      setResult(null);
      setPhase('idle');
    }
  };

  const publish = async () => {
    setPhase('reading');
    setResult(null);
    try {
      await Promise.resolve();
      setPhase('uploading');
      const published = await developerApi.publishPackage({
        applicationId: selectedApplication.id,
        metadataPath,
      });
      setResult(published);
      setPhase('submitted');
      Message.success(t('developerPlatform.upload.submitted'));
    } catch (error) {
      setPhase('error');
      Message.error(formatUiError(normalizeUiError(error, 'developer_publish_failed'), t));
    }
  };

  const currentStep = phase === 'idle' ? 0 : phase === 'reading' ? 1 : phase === 'uploading' ? 2 : 3;
  const progress = phase === 'idle' ? 8 : phase === 'reading' ? 28 : phase === 'uploading' ? 68 : 100;

  return (
    <div className="developer-route">
      <div className="developer-section-heading">
        <div>
          <span>{t('developerPlatform.upload.eyebrow')}</span>
          <h2>{t('developerPlatform.upload.title', { name: selectedApplication.name })}</h2>
          <p>{t('developerPlatform.upload.description')}</p>
        </div>
        <Tag color="green">{t('developerPlatform.upload.digestTrust')}</Tag>
      </div>

      <div className="developer-upload-grid">
        <article className="surface developer-upload-console">
          <div className="developer-card-heading">
            <span>01</span>
            <div>
              <small>{t('developerPlatform.upload.packageMetadata')}</small>
              <h3>{t('developerPlatform.upload.selectPackage')}</h3>
            </div>
            <IconFile />
          </div>
          <div className="developer-path-picker">
            <Input
              value={metadataPath}
              onChange={setMetadataPath}
              placeholder={t('developerPlatform.upload.metadataPlaceholder')}
            />
            <Button onClick={() => void chooseMetadata()}>{t('common.browse')}</Button>
          </div>
          <Alert type="info" content={t('developerPlatform.upload.boundary')} />
          <code className="developer-command">
            aw package --manifest applet.json --input dist --output .aw
          </code>
          <Button
            type="primary"
            size="large"
            icon={<IconUpload />}
            loading={phase === 'reading' || phase === 'uploading'}
            disabled={!metadataPath || phase === 'reading' || phase === 'uploading'}
            onClick={() => void publish()}
          >
            {t('developerPlatform.upload.publish')}
          </Button>
        </article>

        <article className="surface developer-pipeline-card">
          <div className="developer-card-heading">
            <span>02</span>
            <div>
              <small>{t('developerPlatform.upload.pipeline')}</small>
              <h3>{t('developerPlatform.upload.pipelineTitle')}</h3>
            </div>
            <IconLaunch />
          </div>
          <Progress percent={progress} showText={false} color="#c7ff3d" trailColor="#283026" />
          <Steps current={currentStep} direction="vertical" size="small">
            <Steps.Step
              title={t('developerPlatform.upload.steps.read')}
              description={t('developerPlatform.upload.steps.readDetail')}
            />
            <Steps.Step
              title={t('developerPlatform.upload.steps.verify')}
              description={t('developerPlatform.upload.steps.verifyDetail')}
            />
            <Steps.Step
              title={t('developerPlatform.upload.steps.transfer')}
              description={t('developerPlatform.upload.steps.transferDetail')}
            />
            <Steps.Step
              title={t('developerPlatform.upload.steps.validate')}
              description={t('developerPlatform.upload.steps.validateDetail')}
            />
          </Steps>
        </article>
      </div>

      {phase === 'error' && <Alert type="error" content={t('developerPlatform.upload.failed')} />}
      {result && (
        <article className="surface developer-upload-result">
          <IconCheckCircle />
          <div>
            <span>{t('developerPlatform.upload.releaseCreated')}</span>
            <h3>
              {selectedApplication.slug}@{result.version}
            </h3>
            <code>{result.releaseId}</code>
          </div>
          <Tag color="arcoblue">{result.status.toUpperCase()}</Tag>
          <Button type="primary" onClick={() => navigate('/developer/versions')}>
            {t('developerPlatform.upload.openVersions')}
          </Button>
        </article>
      )}
    </div>
  );
}
