import { useMemo, useState } from 'react';
import { Button, Drawer, Empty, Input, Message, Select, Table, Tag } from '@arco-design/web-react';
import { IconEye, IconSearch } from '@arco-design/web-react/icon';

import { taskStatusLabel } from '@/i18n/domain';
import { formatUiError, normalizeUiError } from '@/i18n/errors';
import { useLocale } from '@/i18n/localeContext';
import { desktopHost } from '@/services/desktopHost';
import { selectSnapshot, useDesktopStore } from '@/stores/desktopStore';
import type { DesktopTask } from '@/types';
import { useDeveloperContext } from './developerContext';
import { filterLocalLogs, logSnippet, type LocalLogFilters } from './logSearch';

const EMPTY_TASKS: DesktopTask[] = [];

export function DeveloperLogsPage() {
  const { selectedApplication } = useDeveloperContext();
  const { formatDateTime, t } = useLocale();
  const tasks = useDesktopStore(selectSnapshot)?.tasks ?? EMPTY_TASKS;
  const [filters, setFilters] = useState<LocalLogFilters>({
    appId: '',
    version: '',
    status: 'all',
    window: '7d',
    query: '',
  });
  const [logs, setLogs] = useState<Map<string, string>>(new Map());
  const [searching, setSearching] = useState(false);
  const [opened, setOpened] = useState<{ task: DesktopTask; text: string } | null>(null);
  const appId = selectedApplication?.slug ?? '';
  const versions = useMemo(
    () => [...new Set(tasks.filter((task) => !appId || task.appId === appId).map((task) => task.version))],
    [appId, tasks],
  );
  const effectiveFilters = useMemo(() => ({ ...filters, appId }), [appId, filters]);
  const rows = useMemo(() => filterLocalLogs(tasks, logs, effectiveFilters), [effectiveFilters, logs, tasks]);

  const search = async () => {
    setSearching(true);
    try {
      const candidates = filterLocalLogs(tasks, new Map(), { ...effectiveFilters, query: '' });
      const values = await Promise.all(
        candidates.map(async (task) => [task.taskId, await desktopHost.readTaskLog(task.taskId)] as const),
      );
      setLogs(new Map(values));
    } catch (error) {
      Message.error(formatUiError(normalizeUiError(error, 'task_log_read_failed'), t));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="developer-route">
      <div className="developer-section-heading">
        <div>
          <span>{t('developerPlatform.logs.eyebrow')}</span>
          <h2>{t('developerPlatform.logs.title')}</h2>
          <p>{t('developerPlatform.logs.description')}</p>
        </div>
        <Tag color="green">{t('developerPlatform.logs.localBoundary')}</Tag>
      </div>

      <div className="surface developer-log-filters">
        <Input.Search
          value={filters.query}
          allowClear
          searchButton={t('developerPlatform.logs.search')}
          placeholder={t('developerPlatform.logs.queryPlaceholder')}
          loading={searching}
          onChange={(query) => setFilters((value) => ({ ...value, query }))}
          onSearch={() => void search()}
        />
        <Select
          value={filters.version || 'all'}
          onChange={(version) =>
            setFilters((value) => ({ ...value, version: version === 'all' ? '' : version }))
          }
          options={[
            { label: t('developerPlatform.logs.allVersions'), value: 'all' },
            ...versions.map((version) => ({ label: `v${version}`, value: version })),
          ]}
        />
        <Select
          value={filters.status}
          onChange={(status) => setFilters((value) => ({ ...value, status }))}
          options={[
            { label: t('developerPlatform.logs.allStatuses'), value: 'all' },
            ...(['starting', 'running', 'succeeded', 'failed', 'stopped'] as const).map((status) => ({
              label: taskStatusLabel(status, t),
              value: status,
            })),
          ]}
        />
        <Select
          value={filters.window}
          onChange={(window) => setFilters((value) => ({ ...value, window }))}
          options={[
            { label: t('developerPlatform.windows.24h'), value: '24h' },
            { label: t('developerPlatform.windows.7d'), value: '7d' },
            { label: t('developerPlatform.windows.30d'), value: '30d' },
            { label: t('developerPlatform.windows.all'), value: 'all' },
          ]}
        />
        <Button icon={<IconSearch />} loading={searching} onClick={() => void search()}>
          {t('developerPlatform.logs.reindex')}
        </Button>
      </div>

      <div className="developer-log-summary">
        <span>{t('developerPlatform.logs.results')}</span>
        <strong>{rows.length}</strong>
        <small>{t('developerPlatform.logs.resultDetail')}</small>
      </div>

      <div className="surface table-surface">
        <Table<DesktopTask>
          rowKey="taskId"
          data={rows}
          pagination={{ pageSize: 12 }}
          noDataElement={<Empty description={t('developerPlatform.logs.empty')} />}
          columns={[
            {
              title: t('developerPlatform.logs.columns.task'),
              render: (_, row) => <code>{row.taskId.slice(0, 8)}</code>,
            },
            {
              title: t('developerPlatform.logs.columns.version'),
              render: (_, row) => (
                <strong>
                  {row.appId}@{row.version}
                </strong>
              ),
            },
            {
              title: t('developerPlatform.logs.columns.status'),
              render: (_, row) => (
                <Tag
                  color={row.status === 'failed' ? 'red' : row.status === 'succeeded' ? 'green' : 'arcoblue'}
                >
                  {taskStatusLabel(row.status, t)}
                </Tag>
              ),
            },
            {
              title: t('developerPlatform.logs.columns.started'),
              render: (_, row) => formatDateTime(row.startedAt * 1_000),
            },
            {
              title: t('developerPlatform.logs.columns.match'),
              render: (_, row) => (
                <small className="developer-log-snippet">
                  {logSnippet(logs.get(row.taskId) ?? '', filters.query) || '—'}
                </small>
              ),
            },
            {
              title: '',
              render: (_, row) => (
                <Button
                  type="text"
                  icon={<IconEye />}
                  onClick={() => {
                    const cached = logs.get(row.taskId);
                    if (cached !== undefined) return setOpened({ task: row, text: cached });
                    void desktopHost
                      .readTaskLog(row.taskId)
                      .then((text) => setOpened({ task: row, text }))
                      .catch((error: unknown) =>
                        Message.error(formatUiError(normalizeUiError(error, 'task_log_read_failed'), t)),
                      );
                  }}
                >
                  {t('developerPlatform.logs.open')}
                </Button>
              ),
            },
          ]}
        />
      </div>

      <Drawer
        width={760}
        visible={Boolean(opened)}
        footer={null}
        title={
          opened ? `${opened.task.appId}@${opened.task.version} / ${opened.task.taskId.slice(0, 8)}` : ''
        }
        onCancel={() => setOpened(null)}
      >
        <pre className="log-viewer">{opened?.text}</pre>
      </Drawer>
    </div>
  );
}
