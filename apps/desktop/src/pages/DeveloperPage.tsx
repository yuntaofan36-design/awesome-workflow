import { useState } from 'react';
import { Alert, Button, Input, Message, Steps, Tag } from '@arco-design/web-react';
import { IconFile, IconFolder, IconSend } from '@arco-design/web-react/icon';

import { desktopHost } from '@/services/desktopHost';
import {
  selectRegisterDirectory,
  selectSnapshot,
  selectValidateDirectory,
  selectValidatedManifest,
  useDesktopStore,
} from '@/stores/desktopStore';
import { capabilityLabel, platformLabel } from '@/types';
import type { AppletManifest } from '@/types';

export function DeveloperPage() {
  const [directory, setDirectory] = useState('');
  const [packagePath, setPackagePath] = useState('');
  const [sha256, setSha256] = useState('');
  const [signature, setSignature] = useState('');
  const [keyId, setKeyId] = useState('');
  const [installManifestJson, setInstallManifestJson] = useState('');
  const manifest = useDesktopStore(selectValidatedManifest);
  const installManifest = parseInstallManifest(installManifestJson);
  const validate = useDesktopStore(selectValidateDirectory);
  const register = useDesktopStore(selectRegisterDirectory);
  const snapshot = useDesktopStore(selectSnapshot);

  const chooseDirectory = async () => {
    const selected = await desktopHost.chooseDirectory();
    if (selected) {
      setDirectory(selected);
      await validate(selected);
    }
  };
  const choosePackage = async () => {
    const selected = await desktopHost.choosePackage();
    if (selected) setPackagePath(selected);
  };

  return (
    <section className="page-stack">
      <header className="page-lead">
        <div>
          <span>04</span>
          <p>BUILD / TEST / SHIP</p>
        </div>
        <h1>Developer bay</h1>
        <p>
          Local folders are linked only in developer mode. Production installation requires a separately
          signed Catalog manifest and package attestation; package metadata never upgrades its own trust.
        </p>
      </header>
      {!snapshot?.developerMode && (
        <Alert
          type="info"
          content="Production mode installs only approved Control Plane releases. Local package paths, digests and signatures are intentionally unavailable here."
        />
      )}
      {snapshot?.developerMode && (
        <div className="developer-grid">
          <article className="surface developer-card">
            <div className="surface-heading">
              <div>
                <p>LOCAL LOOP</p>
                <h2>Link an applet directory</h2>
              </div>
              <Tag color="orange">DEV ONLY</Tag>
            </div>
            <div className="path-picker">
              <Input
                value={directory}
                onChange={setDirectory}
                placeholder="Directory containing applet.json"
                prefix={<IconFolder />}
              />
              <Button onClick={() => void chooseDirectory()}>Browse</Button>
            </div>
            {manifest ? (
              <div className="manifest-preview">
                <div>
                  <strong>{manifest.name}</strong>
                  <code>
                    {manifest.appId}@{manifest.version}
                  </code>
                </div>
                <span>
                  {manifest.runtimes
                    .map((runtime) => `${platformLabel(runtime.platform)}/${runtime.kind}`)
                    .join(' · ')}
                </span>
                <div>
                  {manifest.capabilities.map((capability, capabilityIndex) => (
                    <Tag key={`${capability.kind}-${capabilityIndex}`}>{capabilityLabel(capability)}</Tag>
                  ))}
                </div>
              </div>
            ) : (
              <div className="drop-hint">
                Choose a directory to validate manifest paths and target matching.
              </div>
            )}
            <Button
              type="primary"
              disabled={!manifest || !directory}
              onClick={() =>
                void register(directory).then(() => Message.success('Development applet linked'))
              }
            >
              Link & activate
            </Button>
          </article>

          <article className="surface developer-card">
            <div className="surface-heading">
              <div>
                <p>LOCAL INSTALL</p>
                <h2>Install a signed package</h2>
              </div>
              <Tag color="green">FAIL CLOSED</Tag>
            </div>
            <div className="path-picker">
              <Input
                value={packagePath}
                onChange={setPackagePath}
                placeholder="Signed .awpkg"
                prefix={<IconFile />}
              />
              <Button onClick={() => void choosePackage()}>Browse</Button>
            </div>
            <Input value={sha256} onChange={setSha256} placeholder="SHA-256 digest (64 hex characters)" />
            <div className="field-pair">
              <Input value={keyId} onChange={setKeyId} placeholder="Signing key ID" />
              <Input value={signature} onChange={setSignature} placeholder="Ed25519 signature (base64)" />
            </div>
            <Input.TextArea
              value={installManifestJson}
              onChange={setInstallManifestJson}
              autoSize={{ minRows: 4, maxRows: 8 }}
              placeholder="Signed catalog manifest JSON (delivered separately from the .awpkg)"
            />
            <Button
              type="primary"
              disabled={!packagePath || sha256.length !== 64 || !signature || !keyId || !installManifest}
              onClick={() =>
                installManifest &&
                void desktopHost
                  .installSignedPackage({ packagePath, sha256, signature, keyId, manifest: installManifest })
                  .then(() => Message.success('Signed package installed'))
                  .catch((error: unknown) => Message.error(String(error)))
              }
            >
              Verify manifest, package & install
            </Button>
          </article>
        </div>
      )}

      <article className="surface publish-card">
        <div className="surface-heading">
          <div>
            <p>CONTROL PLANE</p>
            <h2>Publish immutable release metadata</h2>
          </div>
          <IconSend />
        </div>
        <Steps current={2} size="small">
          <Steps.Step title="Package" description="awpkg + digest" />
          <Steps.Step title="Sign" description="CI / trusted key" />
          <Steps.Step title="Publish" description="dev channel" />
          <Steps.Step title="Promote" description="canary → stable" />
        </Steps>
        <Alert
          type="info"
          content={
            <>
              Use <code>aw package</code> and <code>aw publish</code>, or the Web Control Plane, for the real
              presigned upload, validation, review and promotion workflow. The desktop UI does not emulate
              that state machine.
            </>
          }
        />
        <Button type="primary" disabled>
          Desktop uploader planned
        </Button>
      </article>
    </section>
  );
}

function parseInstallManifest(value: string): AppletManifest | null {
  if (!value.trim()) return null;
  try {
    const manifest = JSON.parse(value) as unknown;
    return manifest && typeof manifest === 'object' ? (manifest as AppletManifest) : null;
  } catch {
    return null;
  }
}
