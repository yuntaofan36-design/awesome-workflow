import assert from 'node:assert/strict';
import test from 'node:test';

import type { DesktopTask } from '@/types';
import { filterLocalLogs, logSnippet } from './logSearch';

const task: DesktopTask = {
  taskId: '46fe79de-cb55-451d-8e73-5b7b834ba66b',
  appId: 'hello-runner',
  version: '1.0.0',
  status: 'failed',
  logPath: 'task.log',
  startedAt: 1_000,
};

test('local log filtering combines identity, status, time, and text', () => {
  const logs = new Map([[task.taskId, 'INFO boot\nERROR network timeout']]);
  assert.deepEqual(
    filterLocalLogs(
      [task],
      logs,
      { appId: 'hello-runner', version: '1.0.0', status: 'failed', window: '24h', query: 'TIMEOUT' },
      2_000,
    ),
    [task],
  );
  assert.equal(
    filterLocalLogs(
      [task],
      logs,
      { appId: 'hello-runner', version: '', status: 'failed', window: '24h', query: 'missing' },
      2_000,
    ).length,
    0,
  );
});

test('log snippets normalize whitespace around the first match', () => {
  assert.equal(logSnippet('line one\nline two timeout\nline three', 'timeout', 20), '…e two timeout line t…');
});
