import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

import {
  ReleaseValidationJobName,
  ReleaseValidationQueueName,
  ReleaseValidationJobSchema,
  ReleaseValidationResultSchema,
  type ReleaseValidationJob,
} from '@awesome-workflow/contracts';

import { loadWorkerConfig } from './config.js';
import { validateRelease } from './validator.js';

const config = loadWorkerConfig();
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker<ReleaseValidationJob>(
  ReleaseValidationQueueName,
  async (job) => {
    if (job.name !== ReleaseValidationJobName) {
      throw new Error(`Unsupported validation job: ${job.name}`);
    }
    const input = ReleaseValidationJobSchema.parse(job.data);
    const result = ReleaseValidationResultSchema.parse(await validateRelease(input, config));
    await submitResult(result);
    return result;
  },
  { connection, concurrency: 2 },
);

worker.on('completed', (job) => {
  process.stdout.write(`${JSON.stringify({ event: 'release.validated', jobId: job.id })}\n`);
});
worker.on('failed', (job, error) => {
  process.stderr.write(
    `${JSON.stringify({ event: 'release.validation_failed', jobId: job?.id, error: error.message })}\n`,
  );
});

async function submitResult(result: unknown): Promise<void> {
  const parsed = ReleaseValidationResultSchema.parse(result);
  const endpoint = new URL(
    `/api/v1/internal/releases/${encodeURIComponent(parsed.releaseId)}/validation-result`,
    config.WORKER_API_BASE_URL,
  );
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${config.WORKER_CALLBACK_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(parsed),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Validation callback was rejected with status ${response.status}`);
}

async function shutdown(): Promise<void> {
  await worker.close();
  await connection.quit();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
