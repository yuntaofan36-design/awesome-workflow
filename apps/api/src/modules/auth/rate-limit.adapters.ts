import { createHash } from 'node:crypto';

import { Injectable, type OnModuleDestroy } from '@nestjs/common';

import { DomainError } from '../../core/errors.js';
import type { AuthRateLimitPort } from './auth.port.js';

const WINDOW_SECONDS = 15 * 60;
const EMAIL_LIMIT = 5;
const IP_LIMIT = 20;
const PUBLIC_TOKEN_EXCHANGE_LIMIT = 30;

type Bucket = { count: number; resetsAt: number };

@Injectable()
export class MemoryAuthRateLimitAdapter implements AuthRateLimitPort {
  private readonly buckets = new Map<string, Bucket>();

  async consumeEmailChallenge(input: { email: string; clientIp: string; now: Date }): Promise<void> {
    this.consume(`email:${digest(input.email)}`, EMAIL_LIMIT, input.now.getTime());
    this.consume(`ip:${digest(input.clientIp)}`, IP_LIMIT, input.now.getTime());
  }

  async consumePublicTokenExchange(input: { clientIp: string; now: Date }): Promise<void> {
    this.consume(`token-ip:${digest(input.clientIp)}`, PUBLIC_TOKEN_EXCHANGE_LIMIT, input.now.getTime());
  }

  private consume(key: string, limit: number, now: number): void {
    const existing = this.buckets.get(key);
    const bucket =
      !existing || existing.resetsAt <= now ? { count: 0, resetsAt: now + WINDOW_SECONDS * 1000 } : existing;
    bucket.count += 1;
    this.buckets.set(key, bucket);
    if (bucket.count > limit) {
      throw new DomainError(429, 'auth_rate_limited', 'Too many authentication attempts', {
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetsAt - now) / 1000)),
      });
    }
  }
}

export type RedisEvalClient = {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  quit?(): Promise<unknown>;
};

/** Atomic fixed-window limiter for production composition with a Redis client. */
export class RedisAuthRateLimitAdapter implements AuthRateLimitPort, OnModuleDestroy {
  constructor(
    private readonly redis: RedisEvalClient,
    private readonly prefix = 'aw:auth:rate',
  ) {}

  async consumeEmailChallenge(input: { email: string; clientIp: string; now: Date }): Promise<void> {
    const keys = [
      `${this.prefix}:email:${digest(input.email)}`,
      `${this.prefix}:ip:${digest(input.clientIp)}`,
    ];
    const result = await this.redis.eval(REDIS_LIMIT_SCRIPT, {
      keys,
      arguments: [String(EMAIL_LIMIT), String(IP_LIMIT), String(WINDOW_SECONDS)],
    });
    const retryAfterSeconds = Number(result);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      throw new DomainError(429, 'auth_rate_limited', 'Too many authentication attempts', {
        retryAfterSeconds,
      });
    }
  }

  async consumePublicTokenExchange(input: { clientIp: string; now: Date }): Promise<void> {
    const result = await this.redis.eval(REDIS_SINGLE_LIMIT_SCRIPT, {
      keys: [`${this.prefix}:token-ip:${digest(input.clientIp)}`],
      arguments: [String(PUBLIC_TOKEN_EXCHANGE_LIMIT), String(WINDOW_SECONDS)],
    });
    const retryAfterSeconds = Number(result);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      throw new DomainError(429, 'auth_rate_limited', 'Too many authentication attempts', {
        retryAfterSeconds,
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit?.();
  }
}

const REDIS_LIMIT_SCRIPT = `
local emailCount = redis.call('INCR', KEYS[1])
if emailCount == 1 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
local ipCount = redis.call('INCR', KEYS[2])
if ipCount == 1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
if emailCount > tonumber(ARGV[1]) then return redis.call('TTL', KEYS[1]) end
if ipCount > tonumber(ARGV[2]) then return redis.call('TTL', KEYS[2]) end
return 0
`;

const REDIS_SINGLE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if count > tonumber(ARGV[1]) then return redis.call('TTL', KEYS[1]) end
return 0
`;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
