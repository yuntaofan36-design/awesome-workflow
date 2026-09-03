import type { CatalogEntry, FederationManifest } from '../types/catalog';
import { loadFederationModule } from '../runtime/federation';
import { assertFederationOriginsApproved, loadDeploymentFederationPolicy } from '../runtime/federationPolicy';

const parameters = new URLSearchParams(window.location.search);
const allowedOrigin = parameters.get('allowed') ?? 'http://127.0.0.1:4391';
const blockedOrigin = parameters.get('blocked') ?? 'http://127.0.0.1:4392';
const result = document.querySelector<HTMLOutputElement>('#result');

void run().catch((error: unknown) => {
  document.body.dataset.status = 'failed';
  if (result) result.value = error instanceof Error ? error.message : 'unknown failure';
});

async function run(): Promise<void> {
  const digestResponse = await fetch(`${allowedOrigin}/__digest`, {
    cache: 'no-store',
    credentials: 'omit',
  });
  if (!digestResponse.ok) throw new Error(`fixture digest unavailable (${digestResponse.status})`);
  const digest = await digestResponse.text();
  const manifest = createManifest(allowedOrigin, digest.trim());
  const entry = createEntry(manifest);

  const remote = await loadFederationModule(entry);
  if (typeof remote.mount !== 'function' || typeof remote.unmount !== 'function') {
    throw new Error('allowed remote lifecycle was not loaded');
  }
  document.body.dataset.allowedRemote = 'passed';

  const trusted = await loadDeploymentFederationPolicy();
  let policyRejected = false;
  try {
    assertFederationOriginsApproved(createManifest(blockedOrigin, digest.trim()), trusted);
  } catch (error) {
    policyRejected = error instanceof Error && error.message.includes('not approved');
  }
  if (!policyRejected) throw new Error('blocked manifest origin escaped the runtime policy');
  document.body.dataset.runtimeBlock = 'passed';

  await proveBrowserCspBlocksScript(`${blockedOrigin}/probe.js`);
  document.body.dataset.cspBlock = 'passed';
  document.body.dataset.status = 'passed';
  if (result) result.value = 'passed';
}

function createManifest(origin: string, digest: string): FederationManifest {
  return {
    schemaVersion: 1,
    appId: 'federation-csp-fixture',
    version: '1.0.0',
    artifacts: [],
    integrity: { algorithm: 'sha256', digest: '0'.repeat(64) },
    signature: {
      algorithm: 'ed25519',
      keyId: 'browser-fixture',
      value: 'browser-fixture-signature-placeholder-0000000000000000000000000000',
    },
    kind: 'web',
    runtime: 'federation',
    trustTier: 'trusted',
    routeBase: '/federation-csp-fixture',
    hostApiVersion: '1',
    capabilities: [],
    remoteName: 'awesome_control_plane',
    exposedModule: './app',
    manifestUrl: `${origin}/objects/${digest}/mf-manifest.json`,
    integritySha256: digest,
    resourceOrigins: [origin],
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'self'", origin],
      styleSrc: ["'self'", origin],
      imgSrc: ["'self'", origin],
      connectSrc: ["'self'", origin],
      frameSrc: [],
    },
  };
}

function createEntry(manifest: FederationManifest): CatalogEntry & { manifest: FederationManifest } {
  return {
    applicationId: '00000000-0000-4000-8000-000000000101',
    workspaceId: '00000000-0000-4000-8000-000000000010',
    defaultLocale: 'en-US',
    localizations: {},
    slug: 'federation-csp-fixture',
    name: 'Federation CSP fixture',
    summary: 'Browser-level CSP acceptance fixture',
    kind: 'web',
    releaseId: '00000000-0000-4000-8000-000000000201',
    version: '1.0.0',
    channel: 'stable',
    manifest,
    promotedAt: '2026-09-02T00:00:00.000Z',
  };
}

async function proveBrowserCspBlocksScript(source: string): Promise<void> {
  const violation = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error('browser CSP violation was not observed')),
      5_000,
    );
    const listener = (event: SecurityPolicyViolationEvent) => {
      if (event.blockedURI !== source || !event.effectiveDirective.startsWith('script-src')) return;
      window.clearTimeout(timeout);
      document.removeEventListener('securitypolicyviolation', listener);
      resolve();
    };
    document.addEventListener('securitypolicyviolation', listener);
  });
  const script = document.createElement('script');
  script.type = 'module';
  script.src = source;
  document.head.append(script);
  await violation;
  script.remove();
}
