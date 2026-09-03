import { WebResourceOriginSchema, type FederationWebManifest } from '@awesome-workflow/manifest-schema';

export const FEDERATION_POLICY_PATH = '/.well-known/awesome-workflow/federation-policy';

let policyRequest: Promise<ReadonlySet<string>> | undefined;

export function loadDeploymentFederationPolicy(): Promise<ReadonlySet<string>> {
  if (policyRequest) return policyRequest;
  policyRequest = fetch(FEDERATION_POLICY_PATH, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { accept: 'text/plain' },
    redirect: 'error',
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Federation deployment policy is unavailable (${response.status})`);
      }
      return parseDeploymentFederationPolicy(await response.text(), window.location.origin);
    })
    .catch((error) => {
      policyRequest = undefined;
      throw error;
    });
  return policyRequest;
}

export function parseDeploymentFederationPolicy(
  serializedOrigins: string,
  shellOrigin: string,
): ReadonlySet<string> {
  const origins = serializedOrigins
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const trusted = new Set<string>([new URL(shellOrigin).origin]);
  for (const origin of origins) {
    const parsed = WebResourceOriginSchema.safeParse(origin);
    if (!parsed.success) {
      throw new Error(`Federation deployment policy contains an invalid origin: ${origin}`);
    }
    trusted.add(parsed.data);
  }
  return trusted;
}

export function assertFederationOriginsApproved(
  manifest: Pick<FederationWebManifest, 'manifestUrl' | 'resourceOrigins'>,
  trustedOrigins: ReadonlySet<string>,
): void {
  for (const origin of manifest.resourceOrigins) {
    if (!trustedOrigins.has(origin)) {
      throw new Error(`Federation origin is not approved by this shell deployment: ${origin}`);
    }
  }
  const manifestOrigin = new URL(manifest.manifestUrl).origin;
  if (!trustedOrigins.has(manifestOrigin)) {
    throw new Error(`Federation manifest origin is not approved by this shell deployment: ${manifestOrigin}`);
  }
}

export function resetFederationPolicyForTests(): void {
  policyRequest = undefined;
}
