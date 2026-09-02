import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInitialUpdateState,
  isUpdateBusy,
  reduceDesktopUpdate,
  updateProgressPercent,
} from './updateState.js';

const update = { currentVersion: '1.2.3', version: '1.3.0', body: 'Signed release' };

test('browser previews start unavailable and never imply a configured updater', () => {
  assert.equal(createInitialUpdateState(false).phase, 'unavailable');
});

test('signed update flow preserves explicit check, download, install and restart phases', () => {
  let state = createInitialUpdateState(true);
  state = reduceDesktopUpdate(state, { type: 'check-started' });
  assert.equal(state.phase, 'checking');

  state = reduceDesktopUpdate(state, { type: 'update-available', update });
  assert.equal(state.phase, 'available');

  state = reduceDesktopUpdate(state, { type: 'download-started', contentLength: 100 });
  state = reduceDesktopUpdate(state, { type: 'download-progress', chunkLength: 25 });
  state = reduceDesktopUpdate(state, { type: 'download-progress', chunkLength: 100 });
  assert.equal(updateProgressPercent(state), 100);
  assert.equal(isUpdateBusy(state.phase), true);

  state = reduceDesktopUpdate(state, { type: 'download-finished' });
  assert.equal(state.phase, 'downloaded');
  state = reduceDesktopUpdate(state, { type: 'install-started' });
  assert.equal(state.phase, 'installing');
  state = reduceDesktopUpdate(state, { type: 'installed' });
  assert.equal(state.phase, 'restart-required');
});

test('unknown content length stays indeterminate and failures are explicit', () => {
  let state = reduceDesktopUpdate(createInitialUpdateState(true), {
    type: 'download-started',
  });
  assert.equal(updateProgressPercent(state), null);
  state = reduceDesktopUpdate(state, { type: 'failed', error: 'signature rejected' });
  assert.deepEqual(
    { phase: state.phase, error: state.error },
    { phase: 'error', error: 'signature rejected' },
  );
});
