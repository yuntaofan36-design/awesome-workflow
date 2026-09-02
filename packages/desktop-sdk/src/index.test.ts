import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DESKTOP_RPC_PROTOCOL_VERSION,
  DesktopClient,
  type DesktopRpcEnvelope,
  type DesktopRpcTransport,
  getTaskContext,
} from './index.js';

const context = {
  protocolVersion: DESKTOP_RPC_PROTOCOL_VERSION,
  appId: 'sample-app',
  taskId: 'task-1',
  lease: 'lease-value-that-must-never-be-forwarded-remotely',
  rpcEndpoint: String.raw`\\.\pipe\awesome-workflow-task-test`,
  workDirectory: String.raw`C:\tasks\task-1`,
};

test('client binds every call to the Host-provided task scope', async () => {
  const calls: DesktopRpcEnvelope[] = [];
  const transport: DesktopRpcTransport = {
    request: async <TResult>(_endpoint: string, envelope: DesktopRpcEnvelope) => {
      calls.push(envelope);
      return undefined as TResult;
    },
  };
  const client = new DesktopClient(transport, context);
  await client.appendLog('hello');
  await client.setProgress(0.5, 'half way');

  assert.deepEqual(
    calls.map(({ protocolVersion, appId, taskId, lease, method }) => ({
      protocolVersion,
      appId,
      taskId,
      lease,
      method,
    })),
    [
      {
        protocolVersion: 1,
        appId: 'sample-app',
        taskId: 'task-1',
        lease: context.lease,
        method: 'task-log-append',
      },
      {
        protocolVersion: 1,
        appId: 'sample-app',
        taskId: 'task-1',
        lease: context.lease,
        method: 'task-progress',
      },
    ],
  );
});

test('runner context rejects incomplete or incompatible environments', () => {
  assert.throws(() => getTaskContext({}));
  assert.throws(() =>
    getTaskContext({
      AW_PROTOCOL_VERSION: '99',
      AW_APP_ID: 'sample-app',
      AW_TASK_ID: 'task-1',
      AW_LEASE: 'lease',
      AW_RPC_ENDPOINT: context.rpcEndpoint,
      AW_WORK_DIRECTORY: context.workDirectory,
    }),
  );
});
