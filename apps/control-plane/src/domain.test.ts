import { describe, expect, it } from 'vitest';

import { groupByChannel, type CatalogEntry, type ReleaseChannel } from './domain';

function entry(channel: ReleaseChannel, releaseId: string): CatalogEntry {
  return {
    applicationId: 'app-1',
    channel,
    manifest: {
      appId: 'demo',
      artifacts: [],
      capabilities: [],
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: [],
      },
      exposedModule: './app',
      hostApiVersion: '1',
      kind: 'web',
      integrity: {
        algorithm: 'sha256',
        digest: '0000000000000000000000000000000000000000000000000000000000000000',
      },
      integritySha256: '0000000000000000000000000000000000000000000000000000000000000000',
      manifestUrl: 'https://apps.example.com/mf-manifest.json',
      remoteName: 'demo',
      routeBase: '/demo',
      runtime: 'federation',
      schemaVersion: 1,
      signature: {
        algorithm: 'ed25519',
        keyId: 'test-key',
        value: '0000000000000000000000000000000000000000',
      },
      trustTier: 'trusted',
      version: '1.0.0',
    },
    name: 'Demo',
    kind: 'web',
    promotedAt: '2026-09-01T00:00:00.000Z',
    releaseId,
    slug: 'demo',
    summary: 'Demo app',
    version: '1.0.0',
    workspaceId: 'workspace-1',
  };
}

describe('groupByChannel', () => {
  it('groups catalog entries without treating channel differences as review requests', () => {
    const dev = entry('dev', 'release-2');
    const canary = entry('canary', 'release-1');

    expect(groupByChannel([canary, dev])).toEqual({ canary: [canary], dev: [dev], stable: [] });
  });
});
