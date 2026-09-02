import assert from 'node:assert/strict';
import test from 'node:test';

import { runCli } from './cli.js';

const RELEASE_ID = '10000000-0000-4000-8000-000000000001';

test('access tokens are redacted from stdout and stderr even when an API reflects one', async () => {
  const secret = 'super-secret-workload-token-value';
  let stdout = '';
  let stderr = '';
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ detail: `request rejected for ${secret}` }), {
      status: 500,
      headers: { 'content-type': 'application/problem+json' },
    })) as typeof fetch;
  const exitCode = await runCli(
    ['status', '--release-id', RELEASE_ID, '--api', 'https://api.example.test', '--token-env', 'CLI_TOKEN'],
    {
      environment: { CLI_TOKEN: secret },
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      fetchImpl,
    },
  );
  assert.equal(exitCode, 1);
  assert.equal(stdout.includes(secret), false);
  assert.equal(stderr.includes(secret), false);
  assert.match(stderr, /\[redacted\]/);
});

test('status prints only allowlisted release, artifact, and review fields', async () => {
  let stdout = '';
  let stderr = '';
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        data: {
          release: {
            id: RELEASE_ID,
            version: '1.2.3',
            status: 'approved',
            signature: { value: 'do-not-print-signature' },
          },
          artifacts: [{ fileName: 'app.zip', status: 'validated', storageKey: 'secret-storage-key' }],
          reviews: [
            { decision: 'approve', createdAt: '2026-01-01T00:00:00.000Z', reviewerId: 'secret-reviewer-id' },
          ],
          upload: { url: 'https://secret.example.test/presigned' },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  const exitCode = await runCli(
    ['status', '--release-id', RELEASE_ID, '--api', 'https://api.example.test', '--token-env', 'CLI_TOKEN'],
    {
      environment: { CLI_TOKEN: 'session-token-that-must-not-print' },
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      fetchImpl,
    },
  );
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /"version": "1.2.3"/);
  assert.match(stdout, /"decision": "approve"/);
  for (const forbidden of [
    'do-not-print-signature',
    'secret-storage-key',
    'secret-reviewer-id',
    'secret.example.test',
    'session-token-that-must-not-print',
  ]) {
    assert.equal(stdout.includes(forbidden), false);
    assert.equal(stderr.includes(forbidden), false);
  }
});
