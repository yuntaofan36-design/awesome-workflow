import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AW_BRIDGE_VERSION,
  AW_CONNECT_MESSAGE,
  isBridgeRequestEnvelope,
  isExpectedConnectEvent,
  normalizeTargetOrigin,
} from './index.js';

test('normalizes a fixed HTTP origin and rejects wildcard targets', () => {
  assert.equal(normalizeTargetOrigin('https://shell.example.com/path'), 'https://shell.example.com');
  assert.throws(() => normalizeTargetOrigin('*'), /fixed host targetOrigin/);
  assert.throws(() => normalizeTargetOrigin('file:///tmp/shell.html'), /HTTP\(S\)/);
});

test('requires both source and origin for the connect handshake', () => {
  const expectedSource = {} as MessageEventSource;
  const data = { type: AW_CONNECT_MESSAGE, version: AW_BRIDGE_VERSION } as const;

  assert.equal(
    isExpectedConnectEvent(
      { data, origin: 'https://shell.example.com', source: expectedSource },
      expectedSource,
      'https://shell.example.com',
    ),
    true,
  );
  assert.equal(
    isExpectedConnectEvent(
      { data, origin: 'https://evil.example.com', source: expectedSource },
      expectedSource,
      'https://shell.example.com',
    ),
    false,
  );
  assert.equal(
    isExpectedConnectEvent(
      { data, origin: 'https://shell.example.com', source: {} as MessageEventSource },
      expectedSource,
      'https://shell.example.com',
    ),
    false,
  );
});

test('accepts only allowlisted bridge methods', () => {
  assert.equal(isBridgeRequestEnvelope({ id: '1', kind: 'request', method: 'theme.getCurrent' }), true);
  assert.equal(isBridgeRequestEnvelope({ id: '2', kind: 'request', method: 'auth.getToken' }), false);
});
