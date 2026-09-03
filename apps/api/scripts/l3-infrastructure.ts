import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import { createClient, type RedisClientType } from 'redis';

import { loadPlatformConfig } from '@awesome-workflow/config';
import {
  ReleaseValidationJobName,
  ReleaseValidationJobSchema,
  ReleaseValidationQueueName,
} from '@awesome-workflow/contracts';
import {
  canonicalizeManifestForSignature,
  computeArtifactSetIntegritySha256,
  type PublisherSignature,
  type ReleaseManifest,
} from '@awesome-workflow/manifest-schema';

import { loadWorkerConfig } from '../../worker/src/config.js';
import { validateRelease } from '../../worker/src/validator.js';
import { createApiApplication } from '../src/bootstrap.js';
import { DomainError } from '../src/core/errors.js';
import { RedisAuthRateLimitAdapter } from '../src/modules/auth/rate-limit.adapters.js';
import { S3ObjectStorageAdapter } from '../src/modules/control-plane/s3-object-storage.adapter.js';
import type { StoredObjectDeclaration } from '../src/modules/control-plane/object-storage.port.js';

const databaseUrl = requiredEnvironment('DATABASE_URL');
const requireFromWorker = createRequire(new URL('../../worker/package.json', import.meta.url));
const { ZipFile } = requireFromWorker('yazl') as {
  ZipFile: new () => {
    addBuffer(contents: Buffer, name: string, options: { mtime: Date }): void;
    end(): void;
    outputStream: NodeJS.ReadableStream;
  };
};
const redisUrl = requiredEnvironment('REDIS_URL');
const s3Endpoint = requiredEnvironment('S3_ENDPOINT');
const s3Bucket = requiredEnvironment('S3_BUCKET');
const s3AccessKeyId = requiredEnvironment('S3_ACCESS_KEY_ID');
const s3SecretAccessKey = requiredEnvironment('S3_SECRET_ACCESS_KEY');
const runId = requiredEnvironment('AW_L3_RUN_ID');
const adminEmail = requiredEnvironment('AW_L3_ADMIN_EMAIL');
const adminPassword = requiredEnvironment('AW_L3_ADMIN_PASSWORD');
const sessionSecret = requiredEnvironment('AW_L3_SESSION_SECRET');
const otpPepper = requiredEnvironment('AW_L3_OTP_PEPPER');
const workerCallbackToken = requiredEnvironment('AW_L3_WORKER_TOKEN');
const objectPrefix = `l3/${runId}`;
const browserOrigin = 'http://localhost:4300';

const platformConfig = loadPlatformConfig({
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '4100',
  API_PUBLIC_URL: 'http://127.0.0.1:4100',
  WEB_PUBLIC_URL: 'http://127.0.0.1:4300',
  API_ORIGINS: 'http://127.0.0.1:4300',
  REPOSITORY_MODE: 'postgres',
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  SESSION_SECRET: sessionSecret,
  OTP_PEPPER: otpPepper,
  AUTH_MODE: 'local_otp',
  AUTH_PASSWORD_ADMIN_EMAIL: adminEmail,
  AUTH_PASSWORD_ADMIN_PASSWORD: adminPassword,
  EMAIL_DELIVERY: 'noop',
  BOOTSTRAP_ADMIN_EMAILS: adminEmail,
  WORKER_CALLBACK_TOKEN: workerCallbackToken,
  VALIDATION_QUEUE_MODE: 'redis',
  OBJECT_STORAGE_MODE: 's3',
  ARTIFACT_UPLOAD_BASE_URL: `${s3Endpoint}/${s3Bucket}`,
  S3_ENDPOINT: s3Endpoint,
  S3_PUBLIC_ENDPOINT: s3Endpoint,
  S3_REGION: 'us-east-1',
  S3_BUCKET: s3Bucket,
  S3_ACCESS_KEY_ID: s3AccessKeyId,
  S3_SECRET_ACCESS_KEY: s3SecretAccessKey,
  S3_FORCE_PATH_STYLE: 'true',
  OIDC_ENABLED_PROVIDERS: 'email',
  WORKLOAD_OIDC_POLICIES: '[]',
});

const s3Client = new S3Client({
  endpoint: s3Endpoint,
  region: platformConfig.S3_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey },
});
const storage = new S3ObjectStorageAdapter(platformConfig);
const database = postgres(databaseUrl, { max: 2, prepare: false, connect_timeout: 10 });
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null, connectTimeout: 10_000 });
const uploadedKeys: string[] = [];

let api: Awaited<ReturnType<typeof createApiApplication>> | undefined;
let queue: Queue | undefined;
let queueEvents: QueueEvents | undefined;
let worker: Worker | undefined;
let rateLimitClient: RedisClientType | undefined;

try {
  await verifyPostgresMigrations();
  await verifyRedisAndBullMqTransport();
  await verifyS3AndWorkerValidation();
  api = await verifyRealApiHttpAndPostgresSession();
  process.stdout.write(`${JSON.stringify({ level: 'L3', status: 'passed', runId })}\n`);
} finally {
  if (api) await api.close().catch(() => undefined);
  if (worker) await worker.close().catch(() => undefined);
  if (queueEvents) await queueEvents.close().catch(() => undefined);
  if (queue) await queue.close().catch(() => undefined);
  if (rateLimitClient?.isOpen) await rateLimitClient.quit().catch(() => undefined);
  for (const key of uploadedKeys) {
    await s3Client.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: key })).catch(() => undefined);
  }
  s3Client.destroy();
  await redis.quit().catch(() => redis.disconnect());
  await database.end({ timeout: 5 }).catch(() => undefined);
}

async function verifyPostgresMigrations(): Promise<void> {
  const migrationDirectory = fileURLToPath(new URL('../drizzle', import.meta.url));
  const expectedMigrations = (await readdir(migrationDirectory)).filter((entry) =>
    entry.endsWith('.sql'),
  ).length;
  const [{ count }] = await database<{ count: number }[]>`
    select count(*)::integer as count from drizzle.__drizzle_migrations
  `;
  assert.equal(count, expectedMigrations, 'all checked-in Drizzle migrations must be applied');

  const requiredTables = ['users', 'sessions', 'workspaces', 'applications', 'releases', 'artifacts'];
  for (const table of requiredTables) {
    const [{ relation }] = await database<{ relation: string | null }[]>`
      select to_regclass(${`public.${table}`})::text as relation
    `;
    assert.equal(relation, table, `migration must create public.${table}`);
  }
  logStep('postgres', { migrations: count, requiredTables: requiredTables.length });
}

async function verifyRedisAndBullMqTransport(): Promise<void> {
  assert.equal(await redis.ping(), 'PONG');
  const probeKey = `aw:l3:${runId}`;
  await redis.set(probeKey, runId, 'EX', 60);
  assert.equal(await redis.get(probeKey), runId);
  await redis.del(probeKey);

  rateLimitClient = createClient({ url: redisUrl });
  await rateLimitClient.connect();
  const limiter = new RedisAuthRateLimitAdapter(rateLimitClient, `aw:l3:${runId}:auth-rate`);
  const now = new Date();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await limiter.consumeEmailChallenge({
      email: adminEmail,
      clientIp: `192.0.2.${attempt + 1}`,
      now,
    });
  }
  await assert.rejects(
    limiter.consumeEmailChallenge({ email: adminEmail, clientIp: '192.0.2.99', now }),
    (error: unknown) =>
      error instanceof DomainError && error.status === 429 && error.code === 'auth_rate_limited',
  );
  await limiter.consumePasswordLogin({ email: adminEmail, clientIp: '192.0.2.99', now });
  logStep('redis', { ping: 'PONG', atomicAuthRateLimit: 'enforced', bucketIsolation: 'passed' });
}

async function verifyS3AndWorkerValidation(): Promise<void> {
  const federationManifestBytes = Buffer.from(
    JSON.stringify({ name: 'l3Remote', metaData: { remoteEntry: { name: 'remoteEntry.js' } } }),
    'utf8',
  );
  const federationManifestSha256 = sha256(federationManifestBytes);
  const artifactBytes = await createZip([
    ['mf-manifest.json', federationManifestBytes],
    ['remoteEntry.js', Buffer.from(`export const l3Run = ${JSON.stringify(runId)};\n`, 'utf8')],
  ]);
  const sbomBytes = Buffer.from(
    JSON.stringify({ spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT', name: `aw-l3-${runId}` }),
    'utf8',
  );
  const artifactSha256 = sha256(artifactBytes);
  const sbomSha256 = sha256(sbomBytes);
  const artifactKey = `${objectPrefix}/${artifactSha256}/federation-bundle.zip`;
  const sbomKey = `${objectPrefix}/remoteEntry.spdx.json`;
  uploadedKeys.push(artifactKey, sbomKey);

  const artifactDeclaration: StoredObjectDeclaration = {
    key: artifactKey,
    contentType: 'application/zip',
    sha256: artifactSha256,
    size: artifactBytes.length,
  };
  const sbomDeclaration: StoredObjectDeclaration = {
    key: sbomKey,
    contentType: 'application/spdx+json',
    sha256: sbomSha256,
    size: sbomBytes.length,
  };
  await upload(storage, artifactDeclaration, artifactBytes);
  await upload(storage, sbomDeclaration, sbomBytes);

  const deviceArtifactDownload = await storage.createDeviceDownload(artifactKey);
  const directDownload = await fetch(deviceArtifactDownload.url, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(directDownload.status, 200);
  assert.equal(sha256(Buffer.from(await directDownload.arrayBuffer())), artifactSha256);

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const keyId = `l3-${runId}`;
  const artifactSignature = signature(sign(null, Buffer.from(artifactSha256, 'hex'), privateKey), keyId);
  const artifact = {
    name: 'federation-bundle',
    fileName: 'federation-bundle.zip',
    mediaType: 'application/zip',
    size: artifactBytes.length,
    sha256: artifactSha256,
  };
  const resourceOrigin = new URL(s3Endpoint).origin;
  const manifest = {
    schemaVersion: 1,
    appId: 'l3-federation-smoke',
    version: '1.0.0',
    artifacts: [artifact],
    integrity: {
      algorithm: 'sha256',
      digest: await computeArtifactSetIntegritySha256([artifact]),
    },
    signature: signature(Buffer.alloc(64), keyId),
    kind: 'web',
    routeBase: '/l3-smoke',
    hostApiVersion: '1',
    capabilities: [],
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'self'", resourceOrigin],
      styleSrc: ["'self'", resourceOrigin],
      imgSrc: ["'self'"],
      connectSrc: ["'self'", resourceOrigin],
      frameSrc: [],
    },
    resourceOrigins: [resourceOrigin],
    runtime: 'federation',
    trustTier: 'trusted',
    remoteName: 'l3Remote',
    exposedModule: './mount',
    manifestUrl: `${s3Endpoint}/${s3Bucket}/${objectPrefix}/${federationManifestSha256}/mf-manifest.json`,
    integritySha256: federationManifestSha256,
  } as unknown as ReleaseManifest;
  manifest.signature = signature(
    sign(null, Buffer.from(canonicalizeManifestForSignature(manifest), 'utf8'), privateKey),
    keyId,
  );
  const workerArtifactDownload = await storage.createWorkerDownload(artifactKey);
  const workerSbomDownload = await storage.createWorkerDownload(sbomKey);
  const validationJob = ReleaseValidationJobSchema.parse({
    releaseId: randomUUID(),
    manifest,
    artifacts: [
      {
        artifactId: randomUUID(),
        fileName: artifact.fileName,
        url: workerArtifactDownload.url,
        expectedSha256: artifactSha256,
        expectedSize: artifactBytes.length,
        signature: artifactSignature,
        sbom: {
          format: 'spdx-json',
          fileName: 'remoteEntry.spdx.json',
          mediaType: 'application/spdx+json',
          sha256: sbomSha256,
          url: workerSbomDownload.url,
        },
      },
    ],
  });
  const workerConfig = loadWorkerConfig({
    REDIS_URL: redisUrl,
    WORKER_API_BASE_URL: 'http://127.0.0.1:4100',
    WORKER_CALLBACK_TOKEN: workerCallbackToken,
    RELEASE_SIGNING_PUBLIC_KEYS: JSON.stringify({ [keyId]: rawPublicKey }),
    ARTIFACT_ALLOWED_ORIGINS: new URL(s3Endpoint).origin,
  });

  queue = new Queue(ReleaseValidationQueueName, { connection: { url: redisUrl } });
  queueEvents = new QueueEvents(ReleaseValidationQueueName, { connection: { url: redisUrl } });
  worker = new Worker(
    ReleaseValidationQueueName,
    async (job) => {
      assert.equal(job.name, ReleaseValidationJobName);
      return validateRelease(ReleaseValidationJobSchema.parse(job.data), workerConfig);
    },
    { connection: { url: redisUrl }, concurrency: 1 },
  );
  await Promise.all([worker.waitUntilReady(), queueEvents.waitUntilReady()]);
  const queued = await queue.add(ReleaseValidationJobName, validationJob, {
    jobId: `l3-${runId}`,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  });
  const result = (await queued.waitUntilFinished(queueEvents, 60_000)) as Awaited<
    ReturnType<typeof validateRelease>
  >;
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.artifactResults[0]?.actualSha256, artifactSha256);
  logStep('minio-s3-worker', {
    upload: 'presigned-put',
    verification: 'head-size-content-type-sha256-metadata',
    download: 'presigned-get',
    bullMq: 'consumed',
    workerValidation: 'passed',
    federationManifestDigest: 'bound-to-zip-entry',
  });
}

async function verifyRealApiHttpAndPostgresSession() {
  const application = await createApiApplication(platformConfig);
  try {
    await application.listen(0, '127.0.0.1');
    const baseUrl = await application.getUrl();
    const health = await fetch(`${baseUrl}/api/v1/health`, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { data?: { status?: string } }).data?.status, 'ok');

    const login = await fetch(`${baseUrl}/api/v1/auth/password/login`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
      signal: AbortSignal.timeout(15_000),
    });
    if (login.status !== 200) {
      throw new Error(`Password login failed with status ${login.status}: ${await login.text()}`);
    }
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie?.startsWith('aw_session='));
    const session = await fetch(`${baseUrl}/api/v1/auth/session`, {
      headers: { cookie },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (session.status !== 200) {
      throw new Error(`Session lookup failed with status ${session.status}: ${await session.text()}`);
    }
    const payload = (await session.json()) as { data?: { email?: string; platformRoles?: string[] } };
    assert.equal(payload.data?.email, adminEmail);
    assert.deepEqual(payload.data?.platformRoles, ['platform_admin']);

    const [{ users, sessions, workspaces }] = await database<
      { users: number; sessions: number; workspaces: number }[]
    >`
      select
        (select count(*)::integer from users where primary_email = ${adminEmail}) as users,
        (select count(*)::integer from sessions where revoked_at is null) as sessions,
        (select count(*)::integer from workspaces) as workspaces
    `;
    assert.equal(users, 1);
    assert.equal(sessions, 1);
    assert.equal(workspaces, 1);
    logStep('api-http', { health: 200, passwordLogin: 200, persistedSession: true });
    return application;
  } catch (error) {
    await application.close();
    throw error;
  }
}

async function upload(
  adapter: S3ObjectStorageAdapter,
  declaration: StoredObjectDeclaration,
  bytes: Buffer,
): Promise<void> {
  const uploadIntent = await adapter.createUpload(declaration);
  const preflight = await fetch(uploadIntent.url, {
    method: 'OPTIONS',
    headers: {
      origin: browserOrigin,
      'access-control-request-method': uploadIntent.method,
      'access-control-request-headers': Object.keys(uploadIntent.headers).join(','),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(preflight.ok, `S3 CORS preflight failed with status ${preflight.status}`);
  assert.equal(preflight.headers.get('access-control-allow-origin'), browserOrigin);
  const response = await fetch(uploadIntent.url, {
    method: uploadIntent.method,
    headers: { ...uploadIntent.headers, origin: browserOrigin },
    body: bytes,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.ok, `S3 upload failed with status ${response.status}: ${await response.text()}`);
  assert.equal(response.headers.get('access-control-allow-origin'), browserOrigin);
  await adapter.assertUploaded(declaration);
}

function signature(bytes: Buffer, keyId: string): PublisherSignature {
  return { algorithm: 'ed25519', keyId, value: bytes.toString('base64') };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createZip(entries: Array<[string, Buffer]>): Promise<Buffer> {
  const archive = new ZipFile();
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    archive.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
    archive.outputStream.once('error', reject);
  });
  for (const [name, contents] of entries) {
    archive.addBuffer(contents, name, { mtime: new Date('1980-01-01T00:00:00.000Z') });
  }
  archive.end();
  return completed;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the L3 infrastructure smoke`);
  return value;
}

function logStep(component: string, details: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ level: 'L3', component, status: 'passed', ...details })}\n`);
}
