export type FederationGraphPolicy = {
  deploymentOrigins: ReadonlySet<string>;
  manifestUrl: string;
  releaseOrigins: readonly string[];
  shellBaseUrl: string;
};

type JsonRecord = Record<string, unknown>;

/**
 * Validates the executable resource graph represented by both the signed
 * manifest and Module Federation's derived snapshot. This runs before the
 * remote entry is evaluated.
 */
export function assertFederationManifestGraph(
  manifestJson: unknown,
  remoteSnapshot: unknown,
  policy: FederationGraphPolicy,
): void {
  const manifestGraph = readManifestGraph(manifestJson, policy);
  const snapshotGraph = readSnapshotGraph(remoteSnapshot, policy);

  if (manifestGraph.publicPath !== snapshotGraph.publicPath) {
    throw new Error('Federation runtime changed the verified manifest publicPath');
  }
  if (!sameStringSet(manifestGraph.resources, snapshotGraph.resources)) {
    throw new Error('Federation runtime produced a resource graph that differs from the verified manifest');
  }
}

/** Validates a concrete URL observed by a Runtime loader hook. */
export function assertFederationResourceUrl(
  resourceUrl: string,
  label: string,
  policy: FederationGraphPolicy,
): string {
  let parsed: URL;
  try {
    parsed = new URL(resourceUrl, policy.shellBaseUrl);
  } catch {
    throw new Error(`Federation ${label} is not a valid URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`Federation ${label} must use HTTP(S) without embedded credentials`);
  }
  if (!policy.releaseOrigins.includes(parsed.origin)) {
    throw new Error(`Federation ${label} origin is not declared by this release: ${parsed.origin}`);
  }
  if (!policy.deploymentOrigins.has(parsed.origin)) {
    throw new Error(`Federation ${label} origin is not approved by this shell deployment: ${parsed.origin}`);
  }
  return parsed.href;
}

function readManifestGraph(
  value: unknown,
  policy: FederationGraphPolicy,
): { publicPath: string; resources: ReadonlySet<string> } {
  const manifest = requireRecord(value, 'manifest');
  requireString(manifest.id, 'manifest.id');
  requireString(manifest.name, 'manifest.name');
  const metadata = requireRecord(manifest.metaData, 'manifest.metaData');
  requireRecord(metadata.buildInfo, 'manifest.metaData.buildInfo');
  requireRecord(metadata.types, 'manifest.metaData.types');
  requireString(metadata.globalName, 'manifest.metaData.globalName');
  if ('getPublicPath' in metadata) {
    throw new Error('Federation getPublicPath is forbidden because it executes untrusted code');
  }
  if (typeof metadata.publicPath !== 'string') {
    throw new Error('Federation manifest.metaData.publicPath must be a string');
  }

  const publicPath =
    metadata.publicPath === 'auto' ? new URL('.', policy.manifestUrl).href : metadata.publicPath;
  const resources = new Set<string>();
  resources.add(
    resolvePublicResource(
      publicPath,
      readResourcePath(metadata.remoteEntry, 'manifest.metaData.remoteEntry'),
      'remote entry',
      policy,
    ),
  );
  if (metadata.prefetchEntry !== undefined) {
    resources.add(
      resolvePublicResource(
        publicPath,
        readResourcePath(metadata.prefetchEntry, 'manifest.metaData.prefetchEntry'),
        'prefetch entry',
        policy,
      ),
    );
  }

  for (const [index, shared] of requireArray(manifest.shared, 'manifest.shared').entries()) {
    const item = requireRecord(shared, `manifest.shared[${index}]`);
    readAssets(item.assets, `manifest.shared[${index}].assets`, publicPath, policy, resources);
  }
  for (const [index, exposed] of requireArray(manifest.exposes, 'manifest.exposes').entries()) {
    const item = requireRecord(exposed, `manifest.exposes[${index}]`);
    readAssets(item.assets, `manifest.exposes[${index}].assets`, publicPath, policy, resources);
  }
  for (const [index, remote] of requireArray(manifest.remotes, 'manifest.remotes').entries()) {
    const item = requireRecord(remote, `manifest.remotes[${index}]`);
    if (typeof item.entry !== 'string' || item.entry.length === 0) {
      throw new Error(
        `Federation manifest.remotes[${index}] must use an explicit entry; version-only remotes are forbidden`,
      );
    }
    resources.add(assertFederationResourceUrl(item.entry, `nested remote ${index}`, policy));
  }

  return { publicPath, resources };
}

function readSnapshotGraph(
  value: unknown,
  policy: FederationGraphPolicy,
): { publicPath: string; resources: ReadonlySet<string> } {
  const snapshot = requireRecord(value, 'runtime snapshot');
  if ('getPublicPath' in snapshot) {
    throw new Error('Federation runtime snapshot contains forbidden getPublicPath code');
  }
  if (typeof snapshot.publicPath !== 'string') {
    throw new Error('Federation runtime snapshot has no static publicPath');
  }
  const publicPath = snapshot.publicPath;
  const resources = new Set<string>();
  resources.add(
    resolvePublicResource(
      publicPath,
      requireNonEmptyString(snapshot.remoteEntry, 'runtime snapshot.remoteEntry'),
      'runtime remote entry',
      policy,
    ),
  );
  if (snapshot.prefetchEntry !== undefined) {
    resources.add(
      resolvePublicResource(
        publicPath,
        requireNonEmptyString(snapshot.prefetchEntry, 'runtime snapshot.prefetchEntry'),
        'runtime prefetch entry',
        policy,
      ),
    );
  }

  for (const [index, shared] of requireArray(snapshot.shared, 'runtime snapshot.shared').entries()) {
    const item = requireRecord(shared, `runtime snapshot.shared[${index}]`);
    readAssets(item.assets, `runtime snapshot.shared[${index}].assets`, publicPath, policy, resources);
  }
  for (const [index, exposed] of requireArray(snapshot.modules, 'runtime snapshot.modules').entries()) {
    const item = requireRecord(exposed, `runtime snapshot.modules[${index}]`);
    readAssets(item.assets, `runtime snapshot.modules[${index}].assets`, publicPath, policy, resources);
  }

  const remotesInfo = requireRecord(snapshot.remotesInfo, 'runtime snapshot.remotesInfo');
  for (const [name, remoteInfo] of Object.entries(remotesInfo)) {
    const item = requireRecord(remoteInfo, `runtime snapshot.remotesInfo.${name}`);
    resources.add(
      assertFederationResourceUrl(
        requireNonEmptyString(item.matchedVersion, `runtime snapshot.remotesInfo.${name}.matchedVersion`),
        `runtime nested remote ${name}`,
        policy,
      ),
    );
  }

  return { publicPath, resources };
}

function readAssets(
  value: unknown,
  label: string,
  publicPath: string,
  policy: FederationGraphPolicy,
  resources: Set<string>,
): void {
  const assets = requireRecord(value, label);
  assertOnlyKeys(assets, ['js', 'css'], label);
  for (const kind of ['js', 'css'] as const) {
    const group = requireRecord(assets[kind], `${label}.${kind}`);
    assertOnlyKeys(group, ['sync', 'async'], `${label}.${kind}`);
    for (const timing of ['sync', 'async'] as const) {
      for (const [index, resource] of requireArray(group[timing], `${label}.${kind}.${timing}`).entries()) {
        const path = requireNonEmptyString(resource, `${label}.${kind}.${timing}[${index}]`);
        resources.add(resolvePublicResource(publicPath, path, `${kind} asset ${path}`, policy));
      }
    }
  }
}

function readResourcePath(value: unknown, label: string): string {
  const resource = requireRecord(value, label);
  const path = requireString(resource.path, `${label}.path`);
  const name = requireNonEmptyString(resource.name, `${label}.name`);
  requireNonEmptyString(resource.type, `${label}.type`);
  return joinResourcePath(path, name);
}

function joinResourcePath(path: string, name: string): string {
  if (!path || path === '.') return name;
  const normalized = path.startsWith('./') ? path.slice(2) : path.startsWith('/') ? path.slice(1) : path;
  const withoutTrailingSlash = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  return withoutTrailingSlash ? `${withoutTrailingSlash}/${name}` : name;
}

function resolvePublicResource(
  publicPath: string,
  resourcePath: string,
  label: string,
  policy: FederationGraphPolicy,
): string {
  return assertFederationResourceUrl(`${publicPath}${resourcePath}`, label, policy);
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Federation ${label} must be an object`);
  }
  return value as JsonRecord;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Federation ${label} must be an array`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Federation ${label} must be a string`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (text.length === 0) throw new Error(`Federation ${label} must not be empty`);
  return text;
}

function assertOnlyKeys(record: JsonRecord, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected) {
    throw new Error(`Federation ${label} contains an unsupported resource group: ${unexpected}`);
  }
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
