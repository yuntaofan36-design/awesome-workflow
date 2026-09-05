import { createPublicKey, type KeyObject } from 'node:crypto';

import { z } from 'zod';

const WorkerEnvironmentSchema = z.object({
  REDIS_URL: z.string().url(),
  WORKER_API_BASE_URL: z.string().url(),
  WORKER_CALLBACK_TOKEN: z.string().min(32),
  RELEASE_SIGNING_PUBLIC_KEYS: z.string().default('{}'),
  ARTIFACT_ALLOWED_ORIGINS: z.string().min(1),
  ARTIFACT_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(256 * 1024 * 1024),
  ARTIFACT_MAX_FILES: z.coerce.number().int().positive().max(100_000).default(10_000),
  ARTIFACT_MAX_EXPANDED_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024 * 1024),
  SBOM_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(16 * 1024 * 1024),
});

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = WorkerEnvironmentSchema.parse(environment);
  return {
    ...parsed,
    allowedOrigins: new Set(
      parsed.ARTIFACT_ALLOWED_ORIGINS.split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => new URL(value).origin),
    ),
    signingKeys: parseSigningKeys(parsed.RELEASE_SIGNING_PUBLIC_KEYS),
  };
}

export function parseSigningKeys(serialized: string): ReadonlyMap<string, KeyObject> {
  let values: Record<string, string>;
  try {
    values = JSON.parse(serialized) as Record<string, string>;
  } catch {
    values = Object.fromEntries(
      serialized.split(',').map((item) => {
        const separator = item.indexOf('=');
        if (separator <= 0) throw new Error('Signing keys must be a JSON object or keyId=base64 pairs');
        return [item.slice(0, separator).trim(), item.slice(separator + 1).trim()];
      }),
    );
  }

  const result = new Map<string, KeyObject>();
  for (const [keyId, encoded] of Object.entries(values)) {
    if (!keyId || result.has(keyId)) throw new Error('Signing key identifiers must be unique and non-empty');
    const raw = Buffer.from(encoded, 'base64');
    if (raw.length !== 32) throw new Error(`Signing key ${keyId} is not a raw 32-byte Ed25519 public key`);
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    result.set(
      keyId,
      createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: 'der', type: 'spki' }),
    );
  }
  return result;
}
