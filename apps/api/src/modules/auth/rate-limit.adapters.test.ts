import assert from 'node:assert/strict';
import test from 'node:test';

import { DomainError } from '../../core/errors.js';
import { MemoryAuthRateLimitAdapter } from './rate-limit.adapters.js';

test('email challenge rate limiter keys on normalized email and client IP', async () => {
  const limiter = new MemoryAuthRateLimitAdapter();
  const now = new Date('2026-09-01T00:00:00.000Z');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await limiter.consumeEmailChallenge({
      email: 'person@example.test',
      clientIp: `192.0.2.${attempt}`,
      now,
    });
  }
  await assert.rejects(
    limiter.consumeEmailChallenge({ email: 'person@example.test', clientIp: '192.0.2.99', now }),
    (error: unknown) =>
      error instanceof DomainError && error.status === 429 && error.code === 'auth_rate_limited',
  );
});

test('password login has an independent account and IP rate limit', async () => {
  const limiter = new MemoryAuthRateLimitAdapter();
  const now = new Date('2026-09-01T00:00:00.000Z');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await limiter.consumePasswordLogin({
      email: 'admin@example.test',
      clientIp: `198.51.100.${attempt}`,
      now,
    });
  }
  await assert.rejects(
    limiter.consumePasswordLogin({ email: 'admin@example.test', clientIp: '198.51.100.99', now }),
    (error: unknown) =>
      error instanceof DomainError && error.status === 429 && error.code === 'auth_rate_limited',
  );
  await limiter.consumeEmailChallenge({
    email: 'admin@example.test',
    clientIp: '198.51.100.99',
    now,
  });
});
