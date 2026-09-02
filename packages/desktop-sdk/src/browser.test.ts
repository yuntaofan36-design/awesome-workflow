import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserSameOriginRpcTransport,
  createWebUiClient,
  DESKTOP_RPC_PROTOCOL_VERSION,
  DesktopRpcError,
  consumeWebUiTaskContext,
  type DesktopRpcEnvelope,
  type DesktopTaskContext,
  type WebUiFetch,
  type WebUiHistoryLike,
  type WebUiLocationLike,
  WEB_UI_RPC_PATH,
} from './browser.js';

const taskContext: DesktopTaskContext = {
  protocolVersion: DESKTOP_RPC_PROTOCOL_VERSION,
  appId: 'sample-app',
  taskId: 'task-1',
  lease: 'lease-value-that-is-long-enough-and-stays-local',
  rpcEndpoint: WEB_UI_RPC_PATH,
  workDirectory: String.raw`C:\tasks\task-1`,
};

test('fragment bootstrap is strict, scrubbed before parsing, and one-time', () => {
  const location = fakeLocation(`#aw-task=${encodeContext(taskContext)}`);
  const replacements: string[] = [];
  const history = fakeHistory(location, replacements);

  assert.deepEqual(consumeWebUiTaskContext(location, history), taskContext);
  assert.equal(location.hash, '');
  assert.deepEqual(replacements, ['/index.html?mode=test']);
  assert.throws(() => consumeWebUiTaskContext(location, history), DesktopRpcError);

  location.hash = '#aw-task=not+base64url';
  assert.throws(() => consumeWebUiTaskContext(location, history), DesktopRpcError);
  assert.equal(location.hash, '');

  const extraField = { ...taskContext, unexpected: true };
  location.hash = `#aw-task=${encodeContext(extraField)}`;
  assert.throws(() => consumeWebUiTaskContext(location, history), DesktopRpcError);
  assert.equal(location.hash, '');
});

test('Web UI client posts a task-bound envelope only to the fixed loopback RPC path', async () => {
  const location = fakeLocation(`#aw-task=${encodeContext(taskContext)}`);
  const history = fakeHistory(location, []);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: WebUiFetch = async (input, init) => {
    calls.push({ url: input.toString(), init });
    return jsonResponse({
      protocolVersion: DESKTOP_RPC_PROTOCOL_VERSION,
      ok: true,
      data: {
        appId: taskContext.appId,
        taskId: taskContext.taskId,
        workDirectory: taskContext.workDirectory,
        arguments: ['--trigger', 'schedule'],
      },
    });
  };

  const client = createWebUiClient({ location, history, fetch });
  const hostContext = await client.readContext();
  assert.equal(hostContext.taskId, taskContext.taskId);
  assert.deepEqual(hostContext.arguments, ['--trigger', 'schedule']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `http://127.0.0.1:43127${WEB_UI_RPC_PATH}`);
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[0]?.init?.credentials, 'omit');
  assert.equal(calls[0]?.init?.redirect, 'error');
  assert.equal(calls[0]?.init?.referrerPolicy, 'no-referrer');
  const envelope = JSON.parse(String(calls[0]?.init?.body)) as DesktopRpcEnvelope;
  assert.deepEqual(
    {
      protocolVersion: envelope.protocolVersion,
      appId: envelope.appId,
      taskId: envelope.taskId,
      lease: envelope.lease,
      method: envelope.method,
    },
    {
      protocolVersion: DESKTOP_RPC_PROTOCOL_VERSION,
      appId: taskContext.appId,
      taskId: taskContext.taskId,
      lease: taskContext.lease,
      method: 'context-read',
    },
  );
});

test('browser transport rejects cross-origin endpoints and malformed Agent responses', async () => {
  let called = false;
  const transport = new BrowserSameOriginRpcTransport('http://127.0.0.1:43127', async () => {
    called = true;
    return jsonResponse({ protocolVersion: 1, ok: true, data: null });
  });
  const envelope = envelopeFor(taskContext);
  await assert.rejects(transport.request('https://evil.example/rpc', envelope), DesktopRpcError);
  await assert.rejects(transport.request(`${WEB_UI_RPC_PATH}?redirect=1`, envelope), DesktopRpcError);
  assert.equal(called, false);

  assert.throws(
    () => new BrowserSameOriginRpcTransport('https://example.com', async () => jsonResponse({})),
    DesktopRpcError,
  );

  await assert.rejects(
    new BrowserSameOriginRpcTransport('http://127.0.0.1:43127', async () =>
      jsonResponse({ protocolVersion: 99, ok: true, data: null }),
    ).request(WEB_UI_RPC_PATH, envelope),
    /protocol version mismatch/,
  );
  await assert.rejects(
    new BrowserSameOriginRpcTransport('http://127.0.0.1:43127', async () =>
      jsonResponse({ protocolVersion: 1, ok: false, error: 'lease rejected' }),
    ).request(WEB_UI_RPC_PATH, envelope),
    /lease rejected/,
  );
  await assert.rejects(
    new BrowserSameOriginRpcTransport(
      'http://127.0.0.1:43127',
      async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    ).request(WEB_UI_RPC_PATH, envelope),
    /unexpected content type/,
  );
});

function fakeLocation(hash: string): WebUiLocationLike & { hash: string } {
  return {
    hash,
    origin: 'http://127.0.0.1:43127',
    pathname: '/index.html',
    search: '?mode=test',
  };
}

function fakeHistory(
  location: WebUiLocationLike & { hash: string },
  replacements: string[],
): WebUiHistoryLike {
  return {
    state: { retained: true },
    replaceState: (_data, _unused, url) => {
      replacements.push(String(url));
      location.hash = '';
    },
  };
}

function encodeContext(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function envelopeFor(context: DesktopTaskContext): DesktopRpcEnvelope {
  return {
    protocolVersion: context.protocolVersion,
    appId: context.appId,
    taskId: context.taskId,
    lease: context.lease,
    method: 'context-read',
    payload: {},
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
