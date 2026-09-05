import assert from 'node:assert/strict';
import test from 'node:test';

import type { DeveloperRun } from '@/services/developerApi';
import { calculateRunAnalytics, filterRunsByWindow } from './analyticsModel';

const base: DeveloperRun = {
  id: '00000000-0000-4000-8000-000000000001',
  applicationId: '2fd3491c-c53c-4a7c-a377-3c21cce19861',
  releaseId: '8a32ada1-7af9-4df7-903a-df7b05718343',
  status: 'succeeded',
  trigger: 'manual',
  attempt: 1,
  errorCode: null,
  queuedAt: '2026-09-03T01:00:00.000Z',
  startedAt: '2026-09-03T01:00:01.000Z',
  finishedAt: '2026-09-03T01:00:03.000Z',
  result: null,
};

test('run analytics derives success, duration, trend, and error distributions', () => {
  const runs: DeveloperRun[] = [
    base,
    {
      ...base,
      id: '00000000-0000-4000-8000-000000000002',
      status: 'failed',
      errorCode: 'runtime_exit_nonzero',
      startedAt: '2026-09-03T02:00:00.000Z',
      finishedAt: '2026-09-03T02:00:10.000Z',
    },
  ];
  const value = calculateRunAnalytics(runs);
  assert.equal(value.total, 2);
  assert.equal(value.successRate, 0.5);
  assert.equal(value.averageDurationMs, 6_000);
  assert.equal(value.p95DurationMs, 10_000);
  assert.deepEqual(value.errors, [{ key: 'runtime_exit_nonzero', value: 1 }]);
  assert.deepEqual(value.trend, [{ key: '2026-09-03', total: 2, succeeded: 1, failed: 1 }]);
});

test('analytics window applies a stable queued-at boundary', () => {
  const now = Date.parse('2026-09-04T01:00:00.000Z');
  assert.equal(filterRunsByWindow([base], '24h', now).length, 1);
  assert.equal(filterRunsByWindow([base], '7d', now).length, 1);
  assert.equal(filterRunsByWindow([base], 'all', now).length, 1);
  assert.equal(filterRunsByWindow([base], '24h', now + 1).length, 0);
});
