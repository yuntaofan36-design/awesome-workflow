import type { OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import {
  ReleaseValidationJobName,
  ReleaseValidationJobSchema,
  ReleaseValidationQueueName,
  type ReleaseValidationJob,
} from '@awesome-workflow/contracts';

export const VALIDATION_QUEUE = Symbol('VALIDATION_QUEUE');

export interface ValidationQueuePort {
  enqueue(job: ReleaseValidationJob): Promise<void>;
}

export class MemoryValidationQueueAdapter implements ValidationQueuePort {
  readonly jobs: ReleaseValidationJob[] = [];

  async enqueue(job: ReleaseValidationJob): Promise<void> {
    const parsed = ReleaseValidationJobSchema.parse(job);
    const existing = this.jobs.findIndex((candidate) => candidate.releaseId === parsed.releaseId);
    if (existing >= 0) this.jobs[existing] = structuredClone(parsed);
    else this.jobs.push(structuredClone(parsed));
  }
}

export class BullMqValidationQueueAdapter implements ValidationQueuePort, OnModuleDestroy {
  private readonly connection: Redis;
  private readonly queue: Queue<ReleaseValidationJob>;

  constructor(redisUrl: string) {
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<ReleaseValidationJob>(ReleaseValidationQueueName, {
      connection: this.connection,
    });
  }

  async enqueue(job: ReleaseValidationJob): Promise<void> {
    const parsed = ReleaseValidationJobSchema.parse(job);
    await this.queue.add(ReleaseValidationJobName, parsed, {
      jobId: `release-${parsed.releaseId}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10_000 },
      removeOnFail: { age: 30 * 24 * 60 * 60, count: 10_000 },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
