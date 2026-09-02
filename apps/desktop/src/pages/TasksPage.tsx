import { useState } from 'react';
import { Button, Drawer, Empty, Table, Tag } from '@arco-design/web-react';
import { IconEye, IconStop } from '@arco-design/web-react/icon';

import { desktopHost } from '@/services/desktopHost';
import { selectSnapshot, selectStopTask, useDesktopStore } from '@/stores/desktopStore';
import type { DesktopTask } from '@/types';

export function TasksPage() {
  const tasks = useDesktopStore(selectSnapshot)?.tasks ?? [];
  const stop = useDesktopStore(selectStopTask);
  const [log, setLog] = useState<{ taskId: string; text: string } | null>(null);
  const openLog = async (taskId: string) => setLog({ taskId, text: await desktopHost.readTaskLog(taskId) });

  return (
    <section className="page-stack">
      <header className="page-lead">
        <div>
          <span>03</span>
          <p>PROCESS LEDGER</p>
        </div>
        <h1>Runs & logs</h1>
        <p>
          Runner PIDs are subordinate to task leases. Stopping a task revokes the lease before any later host
          call can succeed.
        </p>
      </header>
      <div className="surface table-surface">
        <Table<DesktopTask>
          rowKey="taskId"
          data={tasks}
          pagination={false}
          noDataElement={<Empty description="No local runs yet" />}
          columns={[
            {
              title: 'TASK',
              dataIndex: 'taskId',
              render: (value) => <code>{String(value).slice(0, 8)}</code>,
            },
            {
              title: 'APP / VERSION',
              render: (_, row) => (
                <div>
                  <strong>{row.appId}</strong>
                  <small>v{row.version}</small>
                </div>
              ),
            },
            {
              title: 'STATE',
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
                  {String(value).toUpperCase()}
                </Tag>
              ),
            },
            { title: 'PID', dataIndex: 'pid', render: (value) => value ?? '—' },
            {
              title: 'STARTED',
              dataIndex: 'startedAt',
              render: (value) => new Date(Number(value) * 1000).toLocaleString(),
            },
            {
              title: '',
              render: (_, row) => (
                <div className="row-actions">
                  <Button type="text" icon={<IconEye />} onClick={() => void openLog(row.taskId)}>
                    Log
                  </Button>
                  {row.status === 'running' && (
                    <Button
                      status="danger"
                      type="text"
                      icon={<IconStop />}
                      onClick={() => void stop(row.taskId)}
                    >
                      Stop
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
        title={`TASK LOG / ${log?.taskId.slice(0, 8) ?? ''}`}
        visible={Boolean(log)}
        onCancel={() => setLog(null)}
        footer={null}
      >
        <pre className="log-viewer">{log?.text}</pre>
      </Drawer>
    </section>
  );
}
