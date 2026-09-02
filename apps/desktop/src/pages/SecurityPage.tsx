import { Tag } from '@arco-design/web-react';

const controls = [
  [
    'Renderer isolation',
    'Tauri WebView exposes only named commands; shell and filesystem wildcard plugins are absent.',
    'ENFORCED',
  ],
  [
    'Artifact integrity',
    'SHA-256 is checked before Ed25519 signature verification and before extraction.',
    'ENFORCED',
  ],
  [
    'Archive containment',
    'Absolute paths, parent traversal, symlinks, entry count and expanded size are rejected.',
    'ENFORCED',
  ],
  ['Runtime identity', 'RPC requires protocolVersion + appId + taskId + lease + method.', 'ENFORCED'],
  [
    'Credential boundary',
    'Runner environment is allowlisted; platform cookies and tokens never cross.',
    'ENFORCED',
  ],
  [
    'OS sandbox',
    'Native/Python child sandbox profiles require platform-specific phase-two hardening.',
    'OPEN',
  ],
] as const;

export function SecurityPage() {
  return (
    <section className="page-stack">
      <header className="page-lead">
        <div>
          <span>06</span>
          <p>FAIL-CLOSED BOUNDARIES</p>
        </div>
        <h1>Trust center</h1>
        <p>
          A manifest requests capability; it does not grant capability. Trust is raised only by policy,
          signature, user approval and a short-lived task lease.
        </p>
      </header>
      <div className="security-grid">
        {controls.map(([title, copy, state], index) => (
          <article className="security-control" key={title}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <div>
              <h3>{title}</h3>
              <p>{copy}</p>
            </div>
            <Tag color={state === 'ENFORCED' ? 'green' : 'orange'}>{state}</Tag>
          </article>
        ))}
      </div>
      <article className="surface deny-card">
        <div>
          <p>DEFAULT POLICY</p>
          <h2>Anything not named is denied.</h2>
        </div>
        <code>
          unknown method → deny
          <br />
          unknown capability → deny
          <br />
          expired lease → deny
          <br />
          missing signing key → deny
          <br />
          unsupported target → deny
        </code>
      </article>
    </section>
  );
}
