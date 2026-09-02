import {
  CatalogEntrySchema,
  type CatalogEntry as ContractCatalogEntry,
  type ReleaseChannelName,
} from '@awesome-workflow/contracts';
import { WebReleaseManifestSchema, type WebReleaseManifest } from '@awesome-workflow/manifest-schema';

export type ReleaseChannel = ReleaseChannelName;
export type WebManifest = WebReleaseManifest;
export type FederationManifest = Extract<WebManifest, { runtime: 'federation' }>;
export type IframeManifest = Extract<WebManifest, { runtime: 'iframe' }>;
export type LinkManifest = Extract<WebManifest, { runtime: 'link' }>;
export type CatalogEntry = Omit<ContractCatalogEntry, 'kind' | 'manifest'> & {
  kind: 'web';
  manifest: WebManifest;
};

export function parseCatalogResponse(value: unknown): CatalogEntry[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('Catalog response must contain a data array');
  }
  return CatalogEntrySchema.array().parse(value.data).map(parseCatalogEntry);
}

export function parseCatalogEntry(value: unknown): CatalogEntry {
  const entry = CatalogEntrySchema.parse(value);
  if (entry.kind !== 'web' || entry.manifest.kind !== 'web') {
    throw new Error('Web catalog returned a non-web release');
  }
  const manifest = WebReleaseManifestSchema.parse(entry.manifest);
  enforceHostPolicy(manifest);
  return { ...entry, kind: 'web', manifest };
}

function enforceHostPolicy(manifest: WebManifest): void {
  if (manifest.hostApiVersion !== '1') {
    throw new Error(`Catalog entry requires unsupported Host API v${manifest.hostApiVersion}`);
  }
  const expectedTrustTier = {
    federation: 'trusted',
    iframe: 'isolated',
    link: 'external',
  }[manifest.runtime];
  if (manifest.trustTier !== expectedTrustTier) {
    throw new Error(`Catalog entry has an invalid ${manifest.runtime} trust tier`);
  }
  const cspSources = Object.values(manifest.contentSecurityPolicy).flat();
  if (cspSources.includes('*') || manifest.contentSecurityPolicy.scriptSrc.some(isUnsafeScriptSource)) {
    throw new Error('Catalog entry declares an unsafe content security policy');
  }
  if (manifest.runtime === 'iframe') {
    const frameUrl = new URL(manifest.url);
    if (!import.meta.env.DEV && frameUrl.protocol !== 'https:') {
      throw new Error('Iframe micro-apps require HTTPS outside local development');
    }
    const sandboxCapabilities = new Map([
      ['allow-forms', 'iframe.forms'],
      ['allow-downloads', 'iframe.downloads'],
      ['allow-popups', 'iframe.popups'],
    ] as const);
    for (const [sandboxToken, capability] of sandboxCapabilities) {
      if (manifest.sandbox.includes(sandboxToken) && !manifest.capabilities.includes(capability)) {
        throw new Error(`Catalog entry requests ${sandboxToken} without ${capability}`);
      }
    }
    if (frameUrl.origin !== manifest.allowedOrigin) {
      throw new Error('Catalog entry iframe URL does not match allowedOrigin');
    }
  }
}

function isUnsafeScriptSource(source: string): boolean {
  const normalized = source.toLowerCase();
  const isDevelopmentLoopback = (() => {
    if (!import.meta.env.DEV || !normalized.startsWith('http:')) return false;
    try {
      const hostname = new URL(normalized).hostname;
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    } catch {
      return false;
    }
  })();
  return (
    normalized === "'unsafe-eval'" ||
    normalized === "'unsafe-inline'" ||
    normalized === 'data:' ||
    normalized === 'blob:' ||
    (normalized.startsWith('http:') && !isDevelopmentLoopback)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
