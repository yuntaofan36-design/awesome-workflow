import { useState } from 'react';
import { Button, Drawer, Empty, Message, Table, Tag } from '@arco-design/web-react';
import { IconEye, IconStop } from '@arco-design/web-react/icon';

import { desktopHost } from '@/services/desktopHost';
import { taskStatusLabel } from '@/i18n/domain';
import { formatUiError, normalizeUiError } from '@/i18n/errors';
import { useLocale } from '@/i18n/localeContext';
import { selectSnapshot, selectStopTask, useDesktopStore } from '@/stores/desktopStore';
import type { DesktopTask } from '@/types';

export function TasksPage() {
  const { formatDateTime, formatNumber, t } = useLocale();
  const tasks = useDesktopStore(selectSnapshot)?.tasks ?? [];
  const stop = useDesktopStore(selectStopTask);
  const [log, setLog] = useState<{ taskId: string; text: string } | null>(null);
  const openLog = async (taskId: string) => {
    try {
      setLog({ taskId, text: await desktopHost.readTaskLog(taskId) });
    } catch (error) {
      Message.error(formatUiError(normalizeUiError(error, 'task_log_read_failed'), t));
    }
  };

  return (
    <section className="page-stack">
      <header className="page-lead">
        <div>
          <span>03</span>
          <p>{t('tasks.eyebrow')}</p>
        </div>
        <h1>{t('tasks.title')}</h1>
        <p>{t('tasks.description')}</p>
      </header>
      <div className="surface table-surface">
        <Table<DesktopTask>
          rowKey="taskId"
          data={tasks}
          pagination={false}
          noDataElement={<Empty description={t('tasks.empty')} />}
          columns={[
            {
              title: t('tasks.columns.task'),
              dataIndex: 'taskId',
              render: (value) => <code>{String(value).slice(0, 8)}</code>,
            },
            {
              title: t('tasks.columns.appVersion'),
              render: (_, row) => (
                <div>
                  <strong>{row.appId}</strong>
                  <small>v{row.version}</small>
                </div>
              ),
            },
            {
              title: t('tasks.columns.state'),
              dataIndex: 'status',
              render: (value) => (
                <Tag
                  color={
                    value === 'running'
                      ? 'arcoblue'
                      : value === 'succeeded'
                        ? 'green'
                        : value === 'failed'
                          ? 'red'
                          : 'gray'
                  }
                >
                  {taskStatusLabel(value as DesktopTask['status'], t)}
                </Tag>
              ),
            },
            {
              title: 'PID',
              dataIndex: 'pid',
              render: (value) =>
                typeof value === 'number' ? formatNumber(value, { useGrouping: false }) : '—',
            },
            {
              title: t('tasks.columns.started'),
              dataIndex: 'startedAt',
              render: (value) => formatDateTime(Number(value) * 1000),
            },
            {
              title: '',
              render: (_, row) => (
                <div className="row-actions">
                  <Button type="text" icon={<IconEye />} onClick={() => void openLog(row.taskId)}>
                    {t('common.log')}
                  </Button>
                  {row.status === 'running' && (
                    <Button
                      status="danger"
                      type="text"
                      icon={<IconStop />}
                      onClick={() => void stop(row.taskId)}
                    >
                      {t('common.stop')}
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      </div>
      <Drawer
        width={680}
        title={t('tasks.logTitle', { task: log?.taskId.slice(0, 8) ?? '' })}
        visible={Boolean(log)}
        onCancel={() => setLog(null)}
        footer={null}
      >
        <pre className="log-viewer">{log?.text}</pre>
      </Drawer>
    </section>
  );
}
