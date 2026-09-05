import type { DeveloperRun } from '@/services/developerApi';

export type AnalyticsWindow = '24h' | '7d' | '30d' | 'all';

export type RunAnalytics = {
  total: number;
  succeeded: number;
  failed: number;
  successRate: number;
  averageDurationMs: number;
  p95DurationMs: number;
  trend: Array<{ key: string; total: number; succeeded: number; failed: number }>;
  status: Array<{ key: DeveloperRun['status']; value: number }>;
  errors: Array<{ key: string; value: number }>;
};

const WINDOW_MILLISECONDS: Record<Exclude<AnalyticsWindow, 'all'>, number> = {
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

export function filterRunsByWindow(
  runs: readonly DeveloperRun[],
  window: AnalyticsWindow,
  now = Date.now(),
): DeveloperRun[] {
  if (window === 'all') return [...runs];
  const start = now - WINDOW_MILLISECONDS[window];
  return runs.filter((run) => Date.parse(run.queuedAt) >= start);
}

export function calculateRunAnalytics(runs: readonly DeveloperRun[]): RunAnalytics {
  const completedDurations = runs
    .map(runDuration)
    .filter((duration): duration is number => duration !== null)
    .sort((left, right) => left - right);
  const succeeded = runs.filter((run) => run.status === 'succeeded').length;
  const failed = runs.filter((run) => run.status === 'failed').length;
  const statusCounts = new Map<DeveloperRun['status'], number>();
  const errorCounts = new Map<string, number>();
  const trend = new Map<string, { total: number; succeeded: number; failed: number }>();

  for (const run of runs) {
    statusCounts.set(run.status, (statusCounts.get(run.status) ?? 0) + 1);
    if (run.errorCode) errorCounts.set(run.errorCode, (errorCounts.get(run.errorCode) ?? 0) + 1);
    const key = run.queuedAt.slice(0, 10);
    const bucket = trend.get(key) ?? { total: 0, succeeded: 0, failed: 0 };
    bucket.total += 1;
    if (run.status === 'succeeded') bucket.succeeded += 1;
    if (run.status === 'failed') bucket.failed += 1;
    trend.set(key, bucket);
  }

  return {
    total: runs.length,
    succeeded,
    failed,
    successRate: runs.length === 0 ? 0 : succeeded / runs.length,
    averageDurationMs:
      completedDurations.length === 0
        ? 0
        : completedDurations.reduce((sum, value) => sum + value, 0) / completedDurations.length,
    p95DurationMs: percentile(completedDurations, 0.95),
    trend: [...trend.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, ...value })),
    status: [...statusCounts.entries()]
      .map(([key, value]) => ({ key, value }))
      .sort((left, right) => right.value - left.value),
    errors: [...errorCounts.entries()]
      .map(([key, value]) => ({ key, value }))
      .sort((left, right) => right.value - left.value),
  };
}

function runDuration(run: DeveloperRun): number | null {
  if (!run.startedAt || !run.finishedAt) return null;
  const duration = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]!;
}
