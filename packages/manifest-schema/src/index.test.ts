import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DesktopReleaseManifestSchema,
  FederationWebManifestSchema,
  IframeWebManifestSchema,
  LinkWebManifestSchema,
  canonicalizeArtifactDescriptorSet,
  canonicalizeDesktopCapabilities,
  canonicalizeManifest,
  canonicalizeManifestForSignature,
  computeArtifactSetIntegritySha256,
  computeDesktopCapabilityHash,
} from './index.js';

const digest = 'a'.repeat(64);
const signature = { algorithm: 'ed25519' as const, keyId: 'publisher-2026', value: 'A'.repeat(88) };
const webCsp = {
  defaultSrc: ["'none'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'"],
  connectSrc: ["'self'"],
  frameSrc: [],
};
const identity = {
  schemaVersion: 1 as const,
  appId: 'sample-app',
  version: '1.2.3',
  artifacts: [],
  integrity: { algorithm: 'sha256' as const, digest },
  signature,
};

const federationManifest = {
  ...identity,
  kind: 'web' as const,
  runtime: 'federation' as const,
  routeBase: '/federated-app',
  remoteName: 'federated_app',
  exposedModule: './app',
  manifestUrl: 'https://cdn.example.test/releases/abc/mf-manifest.json',
  integritySha256: digest,
  resourceOrigins: ['https://cdn.example.test'],
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    scriptSrc: ["'self'", 'https://cdn.example.test'],
    styleSrc: ["'self'", 'https://cdn.example.test'],
    imgSrc: ["'self'", 'data:', 'https://cdn.example.test'],
    connectSrc: ["'self'", 'https://cdn.example.test'],
    frameSrc: [],
  },
};

test('federation manifests bind the entry and CSP to exact resource origins', () => {
  assert.equal(FederationWebManifestSchema.safeParse(federationManifest).success, true);
  assert.equal(
    FederationWebManifestSchema.safeParse({
      ...federationManifest,
      resourceOrigins: ['https://assets.example.test'],
    }).success,
    false,
  );
  assert.equal(
    FederationWebManifestSchema.safeParse({
      ...federationManifest,
      contentSecurityPolicy: {
        ...federationManifest.contentSecurityPolicy,
        scriptSrc: ["'self'", 'https://cdn.example.test', 'https://evil.example.test'],
      },
    }).success,
    false,
  );
});

test('federation resource origins reject mutable paths and non-loopback HTTP', () => {
  for (const resourceOrigin of [
    'https://cdn.example.test/assets',
    'https://cdn.example.test/',
    'http://cdn.example.test',
    'https://user@cdn.example.test',
  ]) {
    assert.equal(
      FederationWebManifestSchema.safeParse({ ...federationManifest, resourceOrigins: [resourceOrigin] })
        .success,
      false,
    );
  }
  const loopbackOrigin = 'http://127.0.0.1:4302';
  assert.equal(
    FederationWebManifestSchema.safeParse({
      ...federationManifest,
      manifestUrl: `${loopbackOrigin}/mf-manifest.json`,
      resourceOrigins: [loopbackOrigin],
      contentSecurityPolicy: {
        ...federationManifest.contentSecurityPolicy,
        scriptSrc: ["'self'", loopbackOrigin],
        styleSrc: ["'self'", loopbackOrigin],
        imgSrc: ["'self'", 'data:', loopbackOrigin],
        connectSrc: ["'self'", loopbackOrigin],
      },
    }).success,
    true,
  );
  const ipv6LoopbackOrigin = 'http://[::1]:4302';
  assert.equal(
    FederationWebManifestSchema.safeParse({
      ...federationManifest,
      manifestUrl: `${ipv6LoopbackOrigin}/mf-manifest.json`,
      resourceOrigins: [ipv6LoopbackOrigin],
      contentSecurityPolicy: {
        ...federationManifest.contentSecurityPolicy,
        scriptSrc: ["'self'", ipv6LoopbackOrigin],
        styleSrc: ["'self'", ipv6LoopbackOrigin],
        imgSrc: ["'self'", 'data:', ipv6LoopbackOrigin],
        connectSrc: ["'self'", ipv6LoopbackOrigin],
      },
    }).success,
    true,
  );
});

test('federation CSP rejects unsafe executable and framing sources', () => {
  for (const contentSecurityPolicy of [
    { ...federationManifest.contentSecurityPolicy, scriptSrc: ["'self'", '*'] },
    {
      ...federationManifest.contentSecurityPolicy,
      scriptSrc: ["'self'", 'https://cdn.example.test', "'unsafe-eval'"],
    },
    { ...federationManifest.contentSecurityPolicy, defaultSrc: ['*'] },
    { ...federationManifest.contentSecurityPolicy, frameSrc: ['https://cdn.example.test'] },
  ]) {
    assert.equal(
      FederationWebManifestSchema.safeParse({ ...federationManifest, contentSecurityPolicy }).success,
      false,
    );
  }
});

test('iframe origins must match exactly', () => {
  const result = IframeWebManifestSchema.safeParse({
    ...identity,
    kind: 'web',
    runtime: 'iframe',
    routeBase: '/reports',
    url: 'https://reports.example.test/index.html',
    allowedOrigin: 'https://evil.example.test',
  });
  assert.equal(result.success, false);
});

test('external link runtimes require HTTPS', () => {
  const result = LinkWebManifestSchema.safeParse({
    ...identity,
    kind: 'web',
    runtime: 'link',
    routeBase: '/docs',
    url: 'http://docs.example.test/',
  });
  assert.equal(result.success, false);
});

test('canonical manifests are stable across object key order', () => {
  const first = canonicalizeManifest({
    ...identity,
    kind: 'web',
    runtime: 'link',
    routeBase: '/docs',
    url: 'https://docs.example.test/',
    hostApiVersion: '1',
    capabilities: [],
    contentSecurityPolicy: webCsp,
    trustTier: 'external',
  });
  const second = canonicalizeManifest({
    url: 'https://docs.example.test/',
    routeBase: '/docs',
    runtime: 'link',
    kind: 'web',
    capabilities: [],
    hostApiVersion: '1',
    contentSecurityPolicy: webCsp,
    trustTier: 'external',
    ...identity,
  });
  assert.equal(first, second);
});

test('desktop runtime artifact must be declared for its exact platform', () => {
  const result = DesktopReleaseManifestSchema.safeParse({
    ...identity,
    artifacts: [
      {
        name: 'windows-bundle',
        fileName: 'dist/windows.zip',
        mediaType: 'application/zip',
        size: 1024,
        sha256: digest,
        platform: { os: 'windows', arch: 'x64' },
      },
    ],
    kind: 'desktop',
    name: 'Sample app',
    description: 'A sample desktop micro-application',
    runtimes: [
      {
        kind: 'python',
        platform: { os: 'windows', arch: 'x64' },
        artifact: 'missing-bundle',
        entry: 'main.py',
        python: '3.12',
      },
    ],
    dependencies: [],
    capabilities: [{ kind: 'network', domains: ['api.example.test'], methods: ['GET'] }],
    runMode: 'serial',
    minHostVersion: '1.0.0',
  });
  assert.equal(result.success, false);
  assert.ok(result.error?.issues.some((issue) => issue.path.join('.') === 'runtimes.0.artifact'));
});

test('desktop manifest accepts distinct Windows x64 and macOS arm64 artifacts', () => {
  const result = DesktopReleaseManifestSchema.safeParse({
    ...identity,
    artifacts: [
      {
        name: 'windows-x64',
        fileName: 'windows-x64.zip',
        mediaType: 'application/zip',
        size: 1024,
        sha256: digest,
        platform: { os: 'windows', arch: 'x64' },
      },
      {
        name: 'macos-arm64',
        fileName: 'macos-arm64.zip',
        mediaType: 'application/zip',
        size: 2048,
        sha256: 'b'.repeat(64),
        platform: { os: 'macos', arch: 'arm64' },
      },
    ],
    kind: 'desktop',
    name: 'Multi-platform app',
    description: 'A release with immutable artifacts for both initial target platforms',
    runtimes: [
      {
        kind: 'native',
        platform: { os: 'windows', arch: 'x64' },
        artifact: 'windows-x64',
        entry: 'bin/app.exe',
      },
      {
        kind: 'native',
        platform: { os: 'macos', arch: 'arm64' },
        artifact: 'macos-arm64',
        entry: 'bin/app',
      },
    ],
    dependencies: [],
    capabilities: [],
    runMode: 'singleton',
    minHostVersion: '1.0.0',
  });
  assert.equal(result.success, true);
});

test('desktop runtime cannot reference an artifact built for another platform', () => {
  const result = DesktopReleaseManifestSchema.safeParse({
    ...identity,
    artifacts: [
      {
        name: 'macos-arm64',
        fileName: 'macos-arm64.zip',
        mediaType: 'application/zip',
        size: 1024,
        sha256: digest,
        platform: { os: 'macos', arch: 'arm64' },
      },
    ],
    kind: 'desktop',
    name: 'Mismatched app',
    description: 'The runtime and artifact platforms intentionally differ',
    runtimes: [
      {
        kind: 'native',
        platform: { os: 'windows', arch: 'x64' },
        artifact: 'macos-arm64',
        entry: 'bin/app.exe',
      },
    ],
    dependencies: [],
    capabilities: [],
    runMode: 'singleton',
    minHostVersion: '1.0.0',
  });
  assert.equal(result.success, false);
  assert.ok(result.error?.issues.some((issue) => issue.path.join('.') === 'runtimes.0.artifact'));
});

test('signature payload is deterministic and excludes only the signature value', () => {
  const manifest = {
    ...identity,
    kind: 'web' as const,
    runtime: 'link' as const,
    routeBase: '/docs',
    url: 'https://docs.example.test/',
    hostApiVersion: '1',
    capabilities: [] as never[],
    contentSecurityPolicy: webCsp,
    trustTier: 'external' as const,
  };
  const payload = canonicalizeManifestForSignature(manifest);
  assert.equal(payload.includes(signature.value), false);
  assert.equal(payload.includes(signature.keyId), true);
  assert.equal(payload.includes(digest), true);
  assert.equal(payload, canonicalizeManifestForSignature({ ...manifest, signature: { ...signature } }));
});

test('artifact-set integrity is independent of descriptor order', async () => {
  const artifacts = [
    { name: 'b', fileName: 'b.zip', mediaType: 'application/zip', size: 2, sha256: 'b'.repeat(64) },
    { name: 'a', fileName: 'a.zip', mediaType: 'application/zip', size: 1, sha256: 'a'.repeat(64) },
  ];
  assert.equal(
    canonicalizeArtifactDescriptorSet(artifacts),
    canonicalizeArtifactDescriptorSet([...artifacts].reverse()),
  );
  assert.equal(
    await computeArtifactSetIntegritySha256(artifacts),
    await computeArtifactSetIntegritySha256([...artifacts].reverse()),
  );
});

test('signed artifact ordering is locale-independent code-point order', () => {
  const descriptors = [
    {
      name: 'a-runtime',
      fileName: 'a.zip',
      mediaType: 'application/zip',
      size: 1,
      sha256: 'a'.repeat(64),
    },
    {
      name: 'Z-runtime',
      fileName: 'z.zip',
      mediaType: 'application/zip',
      size: 1,
      sha256: 'b'.repeat(64),
    },
  ];
  const canonical = canonicalizeArtifactDescriptorSet(descriptors);
  assert.ok(canonical.indexOf('Z-runtime') < canonical.indexOf('a-runtime'));
});

test('desktop localized metadata is signed and constrained to supported locales', () => {
  const desktopManifest = {
    ...identity,
    artifacts: [
      {
        name: 'runtime',
        fileName: 'runtime.zip',
        mediaType: 'application/zip',
        size: 1,
        sha256: digest,
        platform: { os: 'windows' as const, arch: 'x64' as const },
      },
    ],
    kind: 'desktop' as const,
    name: 'Localized app',
    description: 'Canonical description',
    runtimes: [
      {
        kind: 'native' as const,
        platform: { os: 'windows' as const, arch: 'x64' as const },
        artifact: 'runtime',
        entry: 'app.exe',
      },
    ],
    dependencies: [],
    capabilities: [],
    runMode: 'singleton' as const,
    minHostVersion: '1.0.0',
  };
  const manifest = DesktopReleaseManifestSchema.parse({
    ...desktopManifest,
    defaultLocale: 'zh-CN',
    localizations: { 'en-US': { name: 'English name', description: 'English description' } },
  });
  assert.equal(manifest.defaultLocale, 'zh-CN');
  assert.match(canonicalizeManifestForSignature(manifest), /English name/);
  assert.equal(
    DesktopReleaseManifestSchema.safeParse({
      ...desktopManifest,
      localizations: { 'fr-FR': { name: 'Nom' } },
    }).success,
    false,
  );
});

test('desktop capability approval identity is independent of declaration order', async () => {
  const capabilities = [
    { kind: 'notifications' as const },
    { kind: 'network' as const, domains: ['api.example.test'], methods: ['GET' as const] },
  ];
  assert.equal(
    canonicalizeDesktopCapabilities(capabilities),
    canonicalizeDesktopCapabilities([...capabilities].reverse()),
  );
  assert.equal(
    await computeDesktopCapabilityHash(capabilities),
    await computeDesktopCapabilityHash([...capabilities].reverse()),
  );
});

test('desktop capability approval identity normalizes nested set order and domain case', async () => {
  const first = [
    {
      kind: 'network' as const,
      domains: ['API.EXAMPLE.TEST', '*.assets.example.test'],
      methods: ['POST' as const, 'GET' as const],
    },
    {
      kind: 'filesystem' as const,
      access: 'read-write' as const,
      scopes: [{ scope: 'user-selected' as const }, { scope: 'app-data' as const }],
    },
    {
      kind: 'lifecycle' as const,
      actions: ['update' as const, 'install' as const],
      elevation: 'user-approved' as const,
    },
  ];
  const reordered = [
    {
      elevation: 'user-approved' as const,
      actions: ['install' as const, 'update' as const],
      kind: 'lifecycle' as const,
    },
    {
      scopes: [{ scope: 'app-data' as const }, { scope: 'user-selected' as const }],
      kind: 'filesystem' as const,
      access: 'read-write' as const,
    },
    {
      methods: ['GET' as const, 'POST' as const],
      domains: ['*.assets.example.test', 'api.example.test'],
      kind: 'network' as const,
    },
  ];

  assert.equal(canonicalizeDesktopCapabilities(first), canonicalizeDesktopCapabilities(reordered));
  assert.equal(await computeDesktopCapabilityHash(first), await computeDesktopCapabilityHash(reordered));
});

test('desktop capability approval identity changes for every material permission expansion', async () => {
  const baseline = [
    { kind: 'filesystem' as const, access: 'read' as const, scopes: [{ scope: 'app-data' as const }] },
  ];
  const candidates = [
    [
      { kind: 'filesystem' as const, access: 'read' as const, scopes: [{ scope: 'app-data' as const }] },
      { kind: 'network' as const, domains: ['api.example.test'], methods: ['GET' as const] },
    ],
    [
      {
        kind: 'filesystem' as const,
        access: 'read-write' as const,
        scopes: [{ scope: 'app-data' as const }],
      },
    ],
    [
      { kind: 'filesystem' as const, access: 'read' as const, scopes: [{ scope: 'app-data' as const }] },
      { kind: 'subprocess' as const, executables: ['bin/helper.exe'] },
    ],
    [
      { kind: 'filesystem' as const, access: 'read' as const, scopes: [{ scope: 'app-data' as const }] },
      {
        kind: 'lifecycle' as const,
        actions: ['install' as const],
        elevation: 'user-approved' as const,
      },
    ],
  ];
  const baselineHash = await computeDesktopCapabilityHash(baseline);
  const expandedHashes = await Promise.all(candidates.map(computeDesktopCapabilityHash));

  assert.equal(
    expandedHashes.every((hash) => hash !== baselineHash),
    true,
  );
  assert.equal(new Set(expandedHashes).size, expandedHashes.length);
});
