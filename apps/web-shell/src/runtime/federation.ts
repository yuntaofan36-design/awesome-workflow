import { createInstance, type ModuleFederationRuntimePlugin } from '@module-federation/runtime';
import {
  assertContentAddressedFederationManifestUrl,
  assertFederationWebPolicy,
} from '@awesome-workflow/manifest-schema';
import type { MicroAppModule } from '@awesome-workflow/web-sdk';

import type { CatalogEntry, FederationManifest } from '../types/catalog';
import {
  assertFederationManifestGraph,
  assertFederationResourceUrl,
  type FederationGraphPolicy,
} from './federationGraphPolicy';
import { assertFederationOriginsApproved, loadDeploymentFederationPolicy } from './federationPolicy';

const moduleCache = new Map<string, Promise<MicroAppModule>>();

export function loadFederationModule(
  entry: CatalogEntry & { manifest: FederationManifest },
): Promise<MicroAppModule> {
  const key = `${entry.releaseId}:${entry.manifest.manifestUrl}:${entry.manifest.exposedModule}`;
  const cached = moduleCache.get(key);
  if (cached) return cached;

  const pending = loadTrustedModule(entry).catch((error) => {
    moduleCache.delete(key);
    throw error;
  });
  moduleCache.set(key, pending);
  return pending;
}

async function loadTrustedModule(
  entry: CatalogEntry & { manifest: FederationManifest },
): Promise<MicroAppModule> {
  const { manifest } = entry;
  assertFederationWebPolicy(manifest);
  const trustedOrigins = await loadDeploymentFederationPolicy();
  assertFederationOriginsApproved(manifest, trustedOrigins);
  const isDevelopmentPlaceholder =
    import.meta.env.DEV &&
    manifest.integritySha256 === '0000000000000000000000000000000000000000000000000000000000000000';
  const loaded = await loadWithCspDiagnostics(manifest.resourceOrigins, async () => {
    if (!isDevelopmentPlaceholder) {
      assertContentAddressedFederationManifestUrl(manifest.manifestUrl, manifest.integritySha256);
    }
    const verifiedManifest = await fetchVerifiedManifest(
      manifest.manifestUrl,
      isDevelopmentPlaceholder ? undefined : manifest.integritySha256,
    );
    const graphPolicy: FederationGraphPolicy = {
      deploymentOrigins: trustedOrigins,
      manifestUrl: manifest.manifestUrl,
      releaseOrigins: manifest.resourceOrigins,
      shellBaseUrl: window.location.href,
    };
    const instance = createInstance({
      name: `awesome_workflow_shell_${manifest.remoteName}_${entry.releaseId.replaceAll('-', '_')}`,
      plugins: [createReleasePolicyPlugin(entry.releaseId, verifiedManifest, graphPolicy)],
      remotes: [{ entry: manifest.manifestUrl, name: manifest.remoteName }],
    });
    const expose = manifest.exposedModule.replace(/^\.\//, '');
    return instance.loadRemote(`${manifest.remoteName}/${expose}`);
  });
  return assertMicroAppModule(loaded, entry.name);
}

type VerifiedFederationManifest = {
  bytes: Uint8Array;
  json: unknown;
};

async function fetchVerifiedManifest(
  url: string,
  expectedDigest: string | undefined,
): Promise<VerifiedFederationManifest> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error(`Unable to verify federation manifest (${response.status})`);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > 2 * 1024 * 1024) {
    throw new Error('Federation manifest exceeds the 2 MiB verification limit');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 2 * 1024 * 1024) {
    throw new Error('Federation manifest exceeds the 2 MiB verification limit');
  }
  if (expectedDigest) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== expectedDigest) {
      throw new Error('Federation manifest integrity verification failed');
    }
  }
  try {
    return {
      bytes,
      json: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
    };
  } catch {
    throw new Error('Federation manifest is not valid UTF-8 JSON');
  }
}

function createReleasePolicyPlugin(
  releaseId: string,
  verifiedManifest: VerifiedFederationManifest,
  policy: FederationGraphPolicy,
): ModuleFederationRuntimePlugin {
  const expectedManifestUrl = new URL(policy.manifestUrl).href;
  let verifiedGraphObserved = false;
  return {
    name: `awesome-workflow-release-policy-${releaseId}`,
    fetch(url) {
      const requestedUrl = new URL(url, policy.shellBaseUrl).href;
      if (requestedUrl === expectedManifestUrl) {
        return Promise.resolve(
          new Response(verifiedManifest.bytes.slice(), {
            headers: { 'content-type': 'application/json; charset=utf-8' },
            status: 200,
          }),
        );
      }
      assertFederationResourceUrl(requestedUrl, 'runtime fetch', policy);
      return undefined;
    },
    loadRemoteSnapshot(context) {
      if (context.from === 'manifest') {
        if (!context.manifestUrl || new URL(context.manifestUrl).href !== expectedManifestUrl) {
          throw new Error('Federation runtime attempted to replace the verified manifest URL');
        }
        if (
          context.manifestJson === undefined ||
          JSON.stringify(context.manifestJson) !== JSON.stringify(verifiedManifest.json)
        ) {
          throw new Error('Federation runtime manifest differs from the integrity-verified bytes');
        }
        assertFederationManifestGraph(verifiedManifest.json, context.remoteSnapshot, policy);
        verifiedGraphObserved = true;
      } else {
        if (!verifiedGraphObserved) {
          throw new Error('Federation runtime attempted to use an unverified global snapshot');
        }
        assertFederationManifestGraph(verifiedManifest.json, context.remoteSnapshot, policy);
      }
      return context;
    },
    createScript({ url }) {
      assertFederationResourceUrl(url, 'runtime script', policy);
      return undefined;
    },
    createLink({ url }) {
      assertFederationResourceUrl(url, 'runtime stylesheet', policy);
      return undefined;
    },
  };
}

async function loadWithCspDiagnostics<T>(
  approvedOrigins: readonly string[],
  load: () => Promise<T>,
): Promise<T> {
  let violation: SecurityPolicyViolationEvent | undefined;
  const recordViolation = (event: SecurityPolicyViolationEvent) => {
    if (
      !['connect-src', 'script-src', 'script-src-elem', 'style-src', 'style-src-elem'].includes(
        event.effectiveDirective,
      )
    ) {
      return;
    }
    if (
      approvedOrigins.some(
        (origin) => event.blockedURI === origin || event.blockedURI.startsWith(`${origin}/`),
      )
    ) {
      violation = event;
    }
  };
  document.addEventListener('securitypolicyviolation', recordViolation);
  try {
    return await load();
  } catch (error) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    if (violation) {
      throw new Error(
        `Browser CSP blocked a trusted Federation resource (${violation.effectiveDirective}) from ${violation.blockedURI}. ` +
          'The deployment policy and Content-Security-Policy header are inconsistent.',
      );
    }
    const detail = error instanceof Error ? error.message : 'unknown runtime failure';
    throw new Error(`Trusted Federation remote failed to load: ${detail}`);
  } finally {
    document.removeEventListener('securitypolicyviolation', recordViolation);
  }
}

function assertMicroAppModule(value: unknown, appName: string): MicroAppModule {
  const candidate = isRecord(value) && isRecord(value.default) ? value.default : value;
  if (
    !isRecord(candidate) ||
    typeof candidate.mount !== 'function' ||
    typeof candidate.unmount !== 'function'
  ) {
    throw new Error(`${appName} does not expose the required mount/unmount lifecycle`);
  }
  return candidate as MicroAppModule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
