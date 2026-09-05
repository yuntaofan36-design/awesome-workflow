import { z } from 'zod';

export const ApplicationSlugSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

export const SemanticVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const HttpUrlSchema = z
  .string()
  .url()
  .refine((url) => /^https?:/.test(url), 'Expected an HTTP(S) URL');
export const HttpsUrlSchema = z
  .string()
  .url()
  .refine((url) => /^https:/.test(url), 'Expected an HTTPS URL');
export const RelativeEntrySchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (entry) => !entry.startsWith('/') && !entry.includes('..') && !entry.includes('\\'),
    'Entry must be a safe relative POSIX path',
  );

export const IntegritySchema = z.object({
  algorithm: z.literal('sha256'),
  digest: Sha256Schema,
});
export type Integrity = z.infer<typeof IntegritySchema>;

export const PublisherSignatureSchema = z.object({
  algorithm: z.literal('ed25519'),
  keyId: z.string().min(1).max(160),
  value: z.string().min(40).max(256),
});
export type PublisherSignature = z.infer<typeof PublisherSignatureSchema>;

export const DesktopPlatformSchema = z.object({
  os: z.enum(['windows', 'macos', 'linux']),
  arch: z.enum(['x64', 'arm64']),
});
export type DesktopPlatform = z.infer<typeof DesktopPlatformSchema>;

export const ManifestArtifactSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  fileName: RelativeEntrySchema,
  mediaType: z.string().min(1).max(120),
  size: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 * 1024 * 1024),
  sha256: Sha256Schema,
  platform: DesktopPlatformSchema.optional(),
});
export type ManifestArtifact = z.infer<typeof ManifestArtifactSchema>;

const manifestIdentity = {
  schemaVersion: z.literal(1),
  appId: ApplicationSlugSchema,
  version: SemanticVersionSchema,
  artifacts: z.array(ManifestArtifactSchema).default([]),
  integrity: IntegritySchema,
};

const signedManifestIdentity = {
  ...manifestIdentity,
  signature: PublisherSignatureSchema,
};

export const WebCapabilitySchema = z.enum([
  'context.read',
  'navigation',
  'notifications',
  'api.fetch',
  'iframe.forms',
  'iframe.downloads',
  'iframe.popups',
]);
export type WebCapability = z.infer<typeof WebCapabilitySchema>;

const CspSourceSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((source) => !/[;\r\n]/.test(source), 'CSP sources cannot contain directives or newlines');

/**
 * Federation resources are executable in the shell document, so an origin is
 * an identity, not a URL prefix. Only canonical HTTPS origins (plus explicit
 * loopback HTTP origins for local development) can be signed into a manifest.
 */
export const WebResourceOriginSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    const isLoopbackHttp =
      url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !isLoopbackHttp) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Federation resource origins require HTTPS except for loopback development',
      });
    }
    if (
      url.origin !== value ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Federation resource origins must be canonical origins without paths or credentials',
      });
    }
  });

export const WebContentSecurityPolicySchema = z.object({
  defaultSrc: z.array(CspSourceSchema).min(1).default(["'none'"]),
  scriptSrc: z.array(CspSourceSchema).default(["'self'"]),
  styleSrc: z.array(CspSourceSchema).default(["'self'"]),
  imgSrc: z.array(CspSourceSchema).default(["'self'"]),
  connectSrc: z.array(CspSourceSchema).default(["'self'"]),
  frameSrc: z.array(CspSourceSchema).default([]),
});
export type WebContentSecurityPolicy = z.infer<typeof WebContentSecurityPolicySchema>;

type FederationPolicyInput = {
  contentSecurityPolicy: WebContentSecurityPolicy;
  manifestUrl: string;
  resourceOrigins: string[];
};

type FederationPolicyIssue = { message: string; path: Array<string | number> };

/**
 * Re-checkable semantic policy used by both the schema and release Worker.
 * The three executable/fetch directives are exact sets: a publisher cannot
 * smuggle a wildcard, scheme source, or a second undeclared CDN into CSP.
 */
export function assertFederationWebPolicy(manifest: FederationPolicyInput): void {
  const issues = federationPolicyIssues(manifest);
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join('; '));
}

/** A production Federation manifest URL must carry its verified digest in its immutable path. */
export function assertContentAddressedFederationManifestUrl(manifestUrl: string, digest: string): void {
  const url = new URL(manifestUrl);
  if (!url.pathname.toLowerCase().includes(digest.toLowerCase())) {
    throw new Error('Federation manifest URL must be content-addressed by integritySha256');
  }
}

function federationPolicyIssues(manifest: FederationPolicyInput): FederationPolicyIssue[] {
  const issues: FederationPolicyIssue[] = [];
  const manifestUrl = new URL(manifest.manifestUrl);
  if (
    manifestUrl.username !== '' ||
    manifestUrl.password !== '' ||
    manifestUrl.hash !== '' ||
    !manifest.resourceOrigins.includes(manifestUrl.origin)
  ) {
    issues.push({
      path: ['manifestUrl'],
      message: 'Federation manifestUrl must use a declared resource origin without credentials or fragments',
    });
  }

  const { contentSecurityPolicy: csp } = manifest;
  if (csp.defaultSrc.length !== 1 || csp.defaultSrc[0] !== "'none'") {
    issues.push({
      path: ['contentSecurityPolicy', 'defaultSrc'],
      message: "Federation defaultSrc must be exactly 'none'",
    });
  }

  const requiredRemoteSources = new Set(["'self'", ...manifest.resourceOrigins]);
  for (const [directive, sources] of [
    ['scriptSrc', csp.scriptSrc],
    ['styleSrc', csp.styleSrc],
    ['connectSrc', csp.connectSrc],
  ] as const) {
    if (!sameStringSet(sources, requiredRemoteSources)) {
      issues.push({
        path: ['contentSecurityPolicy', directive],
        message: `Federation ${directive} must contain only 'self' and every declared resource origin`,
      });
    }
  }

  const allowedImageSources = new Set(["'self'", 'data:', 'blob:', ...manifest.resourceOrigins]);
  if (csp.imgSrc.some((source) => !allowedImageSources.has(source)) || hasDuplicates(csp.imgSrc)) {
    issues.push({
      path: ['contentSecurityPolicy', 'imgSrc'],
      message: 'Federation imgSrc contains an undeclared or duplicate source',
    });
  }
  if (csp.frameSrc.length !== 0) {
    issues.push({
      path: ['contentSecurityPolicy', 'frameSrc'],
      message: 'Federation frameSrc must be empty; untrusted frames use the iframe runtime',
    });
  }
  return issues;
}

function sameStringSet(values: string[], expected: ReadonlySet<string>): boolean {
  return (
    !hasDuplicates(values) && values.length === expected.size && values.every((value) => expected.has(value))
  );
}

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

const webManifestBase = z.object({
  ...signedManifestIdentity,
  kind: z.literal('web'),
  routeBase: z.string().regex(/^\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  hostApiVersion: z.string().min(1).max(32).default('1'),
  capabilities: z.array(WebCapabilitySchema).default([]),
  contentSecurityPolicy: WebContentSecurityPolicySchema.default({
    defaultSrc: ["'none'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: ["'self'"],
    connectSrc: ["'self'"],
    frameSrc: [],
  }),
});

export const FederationWebManifestSchema = webManifestBase
  .extend({
    runtime: z.literal('federation'),
    trustTier: z.literal('trusted').default('trusted'),
    remoteName: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/),
    exposedModule: z.string().regex(/^\.\/[A-Za-z0-9_./-]+$/),
    manifestUrl: HttpUrlSchema,
    integritySha256: Sha256Schema,
    resourceOrigins: z
      .array(WebResourceOriginSchema)
      .min(1)
      .max(16)
      .refine(
        (origins) => new Set(origins).size === origins.length,
        'Federation resource origins must be unique',
      ),
  })
  .superRefine((value, context) => {
    for (const issue of federationPolicyIssues(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, ...issue });
    }
  });
export type FederationWebManifest = z.infer<typeof FederationWebManifestSchema>;

export const IframeWebManifestSchema = webManifestBase
  .extend({
    runtime: z.literal('iframe'),
    trustTier: z.literal('isolated').default('isolated'),
    url: HttpUrlSchema,
    allowedOrigin: z.string().url(),
    sandbox: z
      .array(z.enum(['allow-scripts', 'allow-forms', 'allow-downloads', 'allow-popups']))
      .default(['allow-scripts']),
  })
  .superRefine((value, context) => {
    if (new URL(value.url).origin !== value.allowedOrigin) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedOrigin'],
        message: 'allowedOrigin must match the iframe URL origin',
      });
    }
  });

export const LinkWebManifestSchema = webManifestBase.extend({
  runtime: z.literal('link'),
  trustTier: z.literal('external').default('external'),
  url: HttpsUrlSchema,
  capabilities: z.array(z.never()).default([]),
  artifacts: z.array(z.never()).default([]),
});

export const WebReleaseManifestSchema = z.union([
  FederationWebManifestSchema,
  IframeWebManifestSchema,
  LinkWebManifestSchema,
]);
export type WebReleaseManifest = z.infer<typeof WebReleaseManifestSchema>;

export const FileScopeSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('workspace') }),
  z.object({ scope: z.literal('app-data') }),
  z.object({ scope: z.literal('user-selected') }),
]);

const DomainPatternSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i);

export const DesktopCapabilitySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('filesystem'),
    access: z.enum(['read', 'read-write']),
    scopes: z.array(FileScopeSchema).min(1),
  }),
  z.object({
    kind: z.literal('network'),
    domains: z.array(DomainPatternSchema).min(1),
    methods: z
      .array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']))
      .min(1)
      .default(['GET']),
  }),
  z.object({ kind: z.literal('clipboard'), access: z.enum(['read', 'write', 'read-write']) }),
  z.object({
    kind: z.literal('shortcut'),
    accelerators: z.array(z.string().min(1).max(80)).min(1),
    global: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('background'),
    modes: z.array(z.enum(['scheduled', 'startup', 'persistent'])).min(1),
  }),
  z.object({
    kind: z.literal('lifecycle'),
    actions: z.array(z.enum(['install', 'update', 'uninstall', 'service'])).min(1),
    elevation: z.enum(['never', 'user-approved']).default('never'),
  }),
  z.object({ kind: z.literal('subprocess'), executables: z.array(RelativeEntrySchema).min(1) }),
  z.object({ kind: z.literal('notifications') }),
]);
export type DesktopCapability = z.infer<typeof DesktopCapabilitySchema>;

export const DesktopDependencySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('python'),
    version: z.string().min(1).max(40),
    lockArtifact: z.string().min(1).max(120),
  }),
  z.object({
    kind: z.literal('system'),
    name: z.string().min(1).max(120),
    version: z.string().max(80).optional(),
  }),
  z.object({
    kind: z.literal('application'),
    appId: ApplicationSlugSchema,
    version: z.string().min(1).max(80),
  }),
]);
export type DesktopDependency = z.infer<typeof DesktopDependencySchema>;

const desktopRuntimeBase = z.object({
  platform: DesktopPlatformSchema,
  artifact: z.string().min(1).max(120),
  entry: RelativeEntrySchema,
});

export const PythonDesktopRuntimeSchema = desktopRuntimeBase.extend({
  kind: z.literal('python'),
  python: z.string().min(1).max(40),
});
export const NativeDesktopRuntimeSchema = desktopRuntimeBase.extend({ kind: z.literal('native') });
export const WebUiDesktopRuntimeSchema = desktopRuntimeBase.extend({
  kind: z.literal('web-ui'),
  allowedOrigins: z.array(z.string().url()).default([]),
});

export const DesktopRuntimeSchema = z.discriminatedUnion('kind', [
  PythonDesktopRuntimeSchema,
  NativeDesktopRuntimeSchema,
  WebUiDesktopRuntimeSchema,
]);
export type DesktopRuntime = z.infer<typeof DesktopRuntimeSchema>;

export const ManifestLocaleSchema = z.enum(['en-US', 'zh-CN']);
export type ManifestLocale = z.infer<typeof ManifestLocaleSchema>;

export const DesktopManifestLocalizationsSchema = z
  .object({
    'en-US': z
      .object({ name: z.string().min(2).max(80).optional(), description: z.string().max(240).optional() })
      .strict()
      .optional(),
    'zh-CN': z
      .object({ name: z.string().min(2).max(80).optional(), description: z.string().max(240).optional() })
      .strict()
      .optional(),
  })
  .strict()
  .default({});
export type DesktopManifestLocalizations = z.infer<typeof DesktopManifestLocalizationsSchema>;

export const DesktopReleaseManifestSchema = z
  .object({
    ...manifestIdentity,
    kind: z.literal('desktop'),
    name: z.string().min(2).max(80),
    description: z.string().max(240),
    defaultLocale: ManifestLocaleSchema.default('en-US'),
    localizations: DesktopManifestLocalizationsSchema,
    runtimes: z.array(DesktopRuntimeSchema).min(1),
    dependencies: z.array(DesktopDependencySchema).default([]),
    capabilities: z.array(DesktopCapabilitySchema).default([]),
    runMode: z.enum(['singleton', 'serial', 'parallel']).default('parallel'),
    minHostVersion: SemanticVersionSchema,
  })
  .superRefine((manifest, context) => {
    const artifactNames = new Set<string>();
    const artifactFileNames = new Set<string>();
    const artifactsByName = new Map<string, (typeof manifest.artifacts)[number]>();
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (artifactNames.has(artifact.name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['artifacts', index, 'name'],
          message: 'Artifact names must be unique within a release',
        });
      } else {
        artifactNames.add(artifact.name);
        artifactsByName.set(artifact.name, artifact);
      }
      if (artifactFileNames.has(artifact.fileName)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['artifacts', index, 'fileName'],
          message: 'Artifact file names must be unique within a release',
        });
      }
      artifactFileNames.add(artifact.fileName);
    }
    const targets = new Set<string>();
    for (const [index, runtime] of manifest.runtimes.entries()) {
      const artifact = artifactsByName.get(runtime.artifact);
      if (!artifact) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['runtimes', index, 'artifact'],
          message: 'Runtime artifact must reference an artifact declared by this manifest',
        });
      } else if (
        artifact.platform &&
        (artifact.platform.os !== runtime.platform.os || artifact.platform.arch !== runtime.platform.arch)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['runtimes', index, 'artifact'],
          message: 'Runtime platform must match its platform-specific artifact',
        });
      }
      const target = `${runtime.platform.os}/${runtime.platform.arch}`;
      if (targets.has(target)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['runtimes', index, 'platform'],
          message: 'Only one runtime may be declared for each platform and architecture',
        });
      }
      targets.add(target);
    }
    for (const [index, dependency] of manifest.dependencies.entries()) {
      if (dependency.kind === 'python' && !artifactNames.has(dependency.lockArtifact)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dependencies', index, 'lockArtifact'],
          message: 'Python dependency lock must reference a declared artifact',
        });
      }
    }
  });
export type DesktopReleaseManifest = z.infer<typeof DesktopReleaseManifestSchema>;

export const ReleaseManifestSchema = z.union([WebReleaseManifestSchema, DesktopReleaseManifestSchema]);
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

export function canonicalizeManifest(manifest: ReleaseManifest): string {
  return canonicalJson(ReleaseManifestSchema.parse(manifest));
}

/**
 * Signature payload contract: the canonical parsed manifest with only the
 * signature value removed. Algorithm, key id, and integrity remain bound by
 * the Ed25519 signature, avoiding a self-referential signature value.
 */
export function canonicalizeManifestForSignature(manifest: ReleaseManifest): string {
  const parsed = ReleaseManifestSchema.parse(manifest);
  if (parsed.kind !== 'web') {
    throw new Error('Desktop release manifests do not carry publisher signatures');
  }
  const { value: _signatureValue, ...signatureIdentity } = parsed.signature;
  return canonicalJson({ ...parsed, signature: signatureIdentity });
}

/** Integrity binds the canonical artifact descriptor set, sorted by name. */
export function canonicalizeArtifactDescriptorSet(artifacts: ManifestArtifact[]): string {
  const parsed = z.array(ManifestArtifactSchema).parse(artifacts);
  return canonicalJson([...parsed].sort((left, right) => compareCodePoints(left.name, right.name)));
}

export async function computeArtifactSetIntegritySha256(artifacts: ManifestArtifact[]): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeArtifactDescriptorSet(artifacts));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/** Capabilities are a set: declaration order must not change the approval identity. */
export function canonicalizeDesktopCapabilities(capabilities: DesktopCapability[]): string {
  const parsed = z
    .array(DesktopCapabilitySchema)
    .parse(capabilities)
    .map((capability) =>
      capability.kind === 'network'
        ? { ...capability, domains: capability.domains.map((domain) => domain.toLowerCase()) }
        : capability,
    );
  return canonicalJson(normalizeCapabilitySetValue(parsed));
}

export async function computeDesktopCapabilityHash(capabilities: DesktopCapability[]): Promise<string> {
  const bytes = new TextEncoder().encode(
    `awesome-workflow:desktop-capabilities:v1\n${canonicalizeDesktopCapabilities(capabilities)}`,
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function normalizeCapabilitySetValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeCapabilitySetValue);
    const unique = new Map(normalized.map((entry) => [canonicalJson(entry), entry]));
    return [...unique.entries()]
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([, entry]) => entry);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        normalizeCapabilitySetValue(nested),
      ]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new TypeError('Undefined is not valid canonical JSON');
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError('Value is not valid canonical JSON');
  }
  return encoded;
}

/** Locale-independent ordering for signed and hashed data. */
function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
