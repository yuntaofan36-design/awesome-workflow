import { createInstance } from '@module-federation/runtime';
import type { MicroAppModule } from '@awesome-workflow/web-sdk';

import type { CatalogEntry, FederationManifest } from '../types/catalog';

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
  assertTrustedManifestOrigin(manifest.manifestUrl);
  const isDevelopmentPlaceholder =
    import.meta.env.DEV &&
    manifest.integritySha256 === '0000000000000000000000000000000000000000000000000000000000000000';
  if (manifest.integritySha256 && !isDevelopmentPlaceholder) {
    assertContentAddressedManifestUrl(manifest.manifestUrl, manifest.integritySha256);
    await verifyManifestDigest(manifest.manifestUrl, manifest.integritySha256);
  }

  const instance = createInstance({
    name: `awesome_workflow_shell_${manifest.remoteName}`,
    remotes: [{ entry: manifest.manifestUrl, name: manifest.remoteName }],
  });
  const expose = manifest.exposedModule.replace(/^\.\//, '');
  const loaded = await instance.loadRemote(`${manifest.remoteName}/${expose}`);
  return assertMicroAppModule(loaded, entry.name);
}

export function assertTrustedManifestOrigin(manifestUrl: string): void {
  const url = new URL(manifestUrl);
  if (!import.meta.env.DEV && url.protocol !== 'https:') {
    throw new Error('Federation manifests require HTTPS outside local development');
  }
  const origin = url.origin;
  const configured = (import.meta.env.VITE_TRUSTED_FEDERATION_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin);
  const developmentOrigins = import.meta.env.DEV ? ['http://localhost:4302'] : [];
  const trusted = new Set([window.location.origin, ...developmentOrigins, ...configured]);
  if (!trusted.has(origin)) {
    throw new Error(`Federation manifest origin is not trusted: ${origin}`);
  }
}

function assertContentAddressedManifestUrl(manifestUrl: string, digest: string): void {
  if (import.meta.env.DEV) return;
  const url = new URL(manifestUrl);
  if (!url.pathname.toLowerCase().includes(digest.toLowerCase())) {
    throw new Error('Federation manifest URL is not content-addressed by its expected digest');
  }
}

async function verifyManifestDigest(url: string, expected: string): Promise<void> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error(`Unable to verify federation manifest (${response.status})`);
  const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) throw new Error('Federation manifest integrity verification failed');
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
