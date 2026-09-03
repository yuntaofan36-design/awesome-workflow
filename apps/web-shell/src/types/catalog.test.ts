import { describe, expect, it } from 'vitest';

import { parseCatalogResponse } from './catalog';
import { localizeCatalog } from '../services/catalog';

const iframeEntry = {
  applicationId: '00000000-0000-4000-8000-000000000101',
  channel: 'stable',
  manifest: {
    appId: 'demo',
    allowedOrigin: 'https://micro.example.com',
    artifacts: [],
    capabilities: ['context.read'],
    hostApiVersion: '1',
    kind: 'web',
    integrity: {
      algorithm: 'sha256',
      digest: '0000000000000000000000000000000000000000000000000000000000000000',
    },
    routeBase: '/demo',
    runtime: 'iframe',
    sandbox: ['allow-scripts'],
    schemaVersion: 1,
    signature: { algorithm: 'ed25519', keyId: 'test-key', value: '0000000000000000000000000000000000000000' },
    url: 'https://micro.example.com/app',
    version: '1.0.0',
  },
  name: 'Demo',
  kind: 'web',
  localizations: {
    'zh-CN': { name: '演示应用', summary: '本地化摘要' },
  },
  promotedAt: '2026-09-01T00:00:00.000Z',
  releaseId: '00000000-0000-4000-8000-000000000201',
  slug: 'demo',
  summary: 'Demo app',
  version: '1.0.0',
  workspaceId: '00000000-0000-4000-8000-000000000010',
};

describe('catalog parser', () => {
  it('resolves publisher-authored catalog content with canonical fallback', () => {
    const parsed = parseCatalogResponse({ data: [iframeEntry] });
    expect(
      localizeCatalog(parsed, {
        direction: 'ltr',
        fallbackLocales: ['en-US'],
        locale: 'zh-CN',
        timeZone: 'Asia/Shanghai',
      })[0],
    ).toMatchObject({ name: '演示应用', summary: '本地化摘要' });
    expect(
      localizeCatalog(parsed, {
        direction: 'ltr',
        fallbackLocales: [],
        locale: 'en-US',
        timeZone: 'UTC',
      })[0],
    ).toMatchObject({ name: 'Demo', summary: 'Demo app' });
  });

  it('accepts a separately-originated iframe manifest', () => {
    expect(parseCatalogResponse({ data: [iframeEntry] })[0]?.manifest.runtime).toBe('iframe');
  });

  it('rejects an iframe URL that differs from allowedOrigin', () => {
    expect(() =>
      parseCatalogResponse({
        data: [
          {
            ...iframeEntry,
            manifest: { ...iframeEntry.manifest, allowedOrigin: 'https://evil.example.com' },
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects allow-same-origin even when catalog data requests it', () => {
    expect(() =>
      parseCatalogResponse({
        data: [
          {
            ...iframeEntry,
            manifest: { ...iframeEntry.manifest, sandbox: ['allow-scripts', 'allow-same-origin'] },
          },
        ],
      }),
    ).toThrow();
  });

  it('binds optional iframe sandbox flags to explicit capabilities', () => {
    expect(() =>
      parseCatalogResponse({
        data: [
          {
            ...iframeEntry,
            manifest: { ...iframeEntry.manifest, sandbox: ['allow-scripts', 'allow-forms'] },
          },
        ],
      }),
    ).toThrow(/iframe\.forms/);
    expect(
      parseCatalogResponse({
        data: [
          {
            ...iframeEntry,
            manifest: {
              ...iframeEntry.manifest,
              capabilities: ['context.read', 'iframe.forms'],
              sandbox: ['allow-scripts', 'allow-forms'],
            },
          },
        ],
      }),
    ).toHaveLength(1);
  });

  it('rejects unsafe script CSP sources and mismatched trust tiers', () => {
    expect(() =>
      parseCatalogResponse({
        data: [
          {
            ...iframeEntry,
            manifest: {
              ...iframeEntry.manifest,
              contentSecurityPolicy: {
                defaultSrc: ["'none'"],
                scriptSrc: ["'unsafe-eval'"],
                styleSrc: ["'self'"],
                imgSrc: ["'self'"],
                connectSrc: ["'self'"],
                frameSrc: [],
              },
            },
          },
        ],
      }),
    ).toThrow(/content security policy/);
    expect(() =>
      parseCatalogResponse({
        data: [
          {
            ...iframeEntry,
            manifest: { ...iframeEntry.manifest, trustTier: 'trusted' },
          },
        ],
      }),
    ).toThrow();
  });
});
