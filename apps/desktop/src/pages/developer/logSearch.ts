import type { DesktopTask } from '@/types';

export type LocalLogFilters = {
  appId: string;
  version: string;
  status: DesktopTask['status'] | 'all';
  window: '24h' | '7d' | '30d' | 'all';
  query: string;
};

const WINDOWS = {
  '24h': 86_400,
  '7d': 7 * 86_400,
  '30d': 30 * 86_400,
} as const;

export function filterLocalLogs(
  tasks: readonly DesktopTask[],
  logs: ReadonlyMap<string, string>,
  filters: LocalLogFilters,
  nowSeconds = Date.now() / 1_000,
): DesktopTask[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return tasks.filter((task) => {
    if (filters.appId && task.appId !== filters.appId) return false;
    if (filters.version && task.version !== filters.version) return false;
    if (filters.status !== 'all' && task.status !== filters.status) return false;
    if (filters.window !== 'all' && task.startedAt < nowSeconds - WINDOWS[filters.window]) return false;
    if (query && !(logs.get(task.taskId) ?? '').toLocaleLowerCase().includes(query)) return false;
    return true;
  });
}

export function logSnippet(value: string, query: string, length = 180): string {
  const normalized = query.trim().toLocaleLowerCase();
  const position = normalized ? value.toLocaleLowerCase().indexOf(normalized) : 0;
  const start = Math.max(0, position < 0 ? 0 : position - Math.floor(length / 3));
  const snippet = value
    .slice(start, start + length)
    .replace(/\s+/g, ' ')
    .trim();
  return `${start > 0 ? '…' : ''}${snippet}${start + length < value.length ? '…' : ''}`;
}
