import { describe, expect, it } from 'vitest';

import { decidePreloadReload, PRELOAD_RELOAD_COOLDOWN_MS } from './preloadRecovery';

describe('preload reload gate', () => {
  it('allows the first automatic reload and returns a durable record', () => {
    const decision = decidePreloadReload(null, 'https://shell.example/assets/index-a.js', 10_000);

    expect(decision.reload).toBe(true);
    if (!decision.reload) throw new Error('expected reload decision');
    expect(JSON.parse(decision.record)).toEqual({
      attemptedAt: 10_000,
      entryUrl: 'https://shell.example/assets/index-a.js',
    });
  });

  it('blocks another reload during the cooldown even for a different deployment entry', () => {
    const previous = JSON.stringify({
      attemptedAt: 10_000,
      entryUrl: 'https://shell.example/assets/index-a.js',
    });

    expect(decidePreloadReload(previous, 'https://shell.example/assets/index-b.js', 10_001)).toEqual({
      reload: false,
    });
  });

  it('blocks reload when the clock moves backwards', () => {
    const previous = JSON.stringify({
      attemptedAt: 10_000,
      entryUrl: 'https://shell.example/assets/index-a.js',
    });

    expect(decidePreloadReload(previous, 'https://shell.example/assets/index-a.js', 9_000)).toEqual({
      reload: false,
    });
  });

  it('allows recovery again after the cooldown and ignores malformed records', () => {
    const previous = JSON.stringify({
      attemptedAt: 10_000,
      entryUrl: 'https://shell.example/assets/index-a.js',
    });

    expect(
      decidePreloadReload(
        previous,
        'https://shell.example/assets/index-a.js',
        10_000 + PRELOAD_RELOAD_COOLDOWN_MS,
      ).reload,
    ).toBe(true);
    expect(decidePreloadReload('{invalid', 'entry', 10_001).reload).toBe(true);
  });
});
