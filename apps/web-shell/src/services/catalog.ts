import { apiRequest } from './http';
import { parseCatalogResponse, type CatalogEntry, type ReleaseChannel } from '../types/catalog';

export async function getCatalog(
  workspaceId: string,
  channel: ReleaseChannel = 'stable',
): Promise<CatalogEntry[]> {
  const query = new URLSearchParams({ channel, kind: 'web', workspaceId });
  const remoteEntries = parseCatalogResponse(await apiRequest<unknown>(`/catalog?${query.toString()}`));

  if (!shouldIncludeLocalApps()) return remoteEntries;
  const localEntries = createLocalCatalog(workspaceId, channel);
  return [
    ...remoteEntries,
    ...localEntries.filter((local) => !remoteEntries.some((remote) => remote.slug === local.slug)),
  ];
}

function shouldIncludeLocalApps(): boolean {
  return import.meta.env.DEV && import.meta.env.VITE_INCLUDE_LOCAL_APPS === 'true';
}

function createLocalCatalog(workspaceId: string, channel: ReleaseChannel): CatalogEntry[] {
  const promotedAt = '2026-09-01T00:00:00.000Z';
  const developmentDigest = '0000000000000000000000000000000000000000000000000000000000000000';
  const developmentSignature = {
    algorithm: 'ed25519' as const,
    keyId: 'development-local-placeholder',
    value: 'development-only-unsigned-placeholder-000000000000000000000000',
  };
  const controlPlaneManifestUrl =
    import.meta.env.VITE_CONTROL_PLANE_MANIFEST_URL ?? 'http://localhost:4302/mf-manifest.json';
  const demoIframeUrl = import.meta.env.VITE_DEMO_IFRAME_URL ?? 'http://127.0.0.1:4301/';
  return [
    {
      applicationId: '00000000-0000-4000-8000-000000000101',
      channel,
      kind: 'web',
      manifest: {
        appId: 'control-plane',
        artifacts: [],
        capabilities: ['context.read', 'navigation', 'notifications'],
        contentSecurityPolicy: {
          defaultSrc: ["'none'"],
          scriptSrc: ["'self'", new URL(controlPlaneManifestUrl).origin],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameSrc: [],
        },
        exposedModule: './app',
        hostApiVersion: '1',
        kind: 'web',
        integrity: { algorithm: 'sha256', digest: developmentDigest },
        integritySha256: developmentDigest,
        manifestUrl: controlPlaneManifestUrl,
        remoteName: 'awesome_control_plane',
        routeBase: '/control-plane',
        runtime: 'federation',
        schemaVersion: 1,
        signature: developmentSignature,
        trustTier: 'trusted',
        version: '0.1.0',
      },
      name: 'Control Plane',
      promotedAt,
      releaseId: '00000000-0000-4000-8000-000000000201',
      slug: 'control-plane',
      summary: 'Register applications, publish immutable releases, and promote channels.',
      version: '0.1.0',
      workspaceId,
    },
    {
      applicationId: '00000000-0000-4000-8000-000000000102',
      channel,
      kind: 'web',
      manifest: {
        appId: 'signal-board',
        allowedOrigin: new URL(demoIframeUrl).origin,
        artifacts: [],
        capabilities: ['context.read', 'navigation', 'notifications', 'iframe.forms'],
        contentSecurityPolicy: {
          defaultSrc: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameSrc: [],
        },
        hostApiVersion: '1',
        kind: 'web',
        integrity: { algorithm: 'sha256', digest: developmentDigest },
        routeBase: '/signal-board',
        runtime: 'iframe',
        sandbox: ['allow-scripts', 'allow-forms'],
        schemaVersion: 1,
        signature: developmentSignature,
        trustTier: 'isolated',
        url: demoIframeUrl,
        version: '0.1.0',
      },
      name: 'Signal Board',
      promotedAt,
      releaseId: '00000000-0000-4000-8000-000000000202',
      slug: 'signal-board',
      summary: 'Reference cross-origin micro-application using the capability bridge.',
      version: '0.1.0',
      workspaceId,
    },
    {
      applicationId: '00000000-0000-4000-8000-000000000103',
      channel,
      kind: 'web',
      manifest: {
        appId: 'architecture-notes',
        artifacts: [],
        capabilities: [],
        contentSecurityPolicy: {
          defaultSrc: ["'none'"],
          scriptSrc: [],
          styleSrc: [],
          imgSrc: [],
          connectSrc: [],
          frameSrc: [],
        },
        hostApiVersion: '1',
        kind: 'web',
        integrity: { algorithm: 'sha256', digest: developmentDigest },
        routeBase: '/architecture-notes',
        runtime: 'link',
        schemaVersion: 1,
        signature: developmentSignature,
        trustTier: 'external',
        url: 'https://module-federation.io/',
        version: '1.0.0',
      },
      name: 'Architecture Notes',
      promotedAt,
      releaseId: '00000000-0000-4000-8000-000000000203',
      slug: 'architecture-notes',
      summary: 'External documentation opened without executing inside the host.',
      version: '1.0.0',
      workspaceId,
    },
  ];
}
