import { Alert, Progress, Tag } from '@arco-design/web-react';

import { selectSnapshot, useDesktopStore } from '@/stores/desktopStore';

export function SchedulesPage() {
  const sync = useDesktopStore(selectSnapshot)?.sync;
  return (
    <section className="page-stack">
      <header className="page-lead">
        <div>
          <span>05</span>
          <p>REVISIONED LOCAL EXECUTION</p>
        </div>
        <h1>Schedule mirror</h1>
        <p>
          The server owns schedule intent. The Agent stores only the newest monotonic snapshot and explicitly
          marks stale connectivity as offline.
        </p>
      </header>
      {sync?.offline && (
        <Alert
          type="warning"
          content="Agent is offline. Existing local schedules remain visible, but no stale snapshot can overwrite a newer revision."
        />
      )}
      <div className="schedule-layout">
        <article className="surface revision-card">
          <p>CURRENT REVISION</p>
          <strong>{String(sync?.revision ?? 0).padStart(4, '0')}</strong>
          <Tag color={sync?.offline ? 'orange' : 'green'}>
            {sync?.offline ? 'OFFLINE CACHE' : 'SERVER CONFIRMED'}
          </Tag>
          <Progress
            percent={sync?.offline ? 38 : 100}
            showText={false}
            color={sync?.offline ? '#ff9a3d' : '#c7ff3d'}
          />
        </article>
        <article className="surface schedule-contract">
          <p>SYNC CONTRACT</p>
          <ol>
            <li>
              <b>01</b>
              <span>Fetch snapshot with revision</span>
            </li>
            <li>
              <b>02</b>
              <span>Reject revision ≤ local revision</span>
            </li>
            <li>
              <b>03</b>
              <span>Commit schedules + revision atomically</span>
            </li>
            <li>
              <b>04</b>
              <span>Run through the same lease-bound Agent path</span>
            </li>
          </ol>
        </article>
      </div>
    </section>
  );
}
