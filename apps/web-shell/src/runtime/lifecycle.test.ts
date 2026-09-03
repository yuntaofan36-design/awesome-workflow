import { describe, expect, it } from 'vitest';

import type { CatalogEntry } from '../types/catalog';
import { runtimeReleaseKey, runtimeScopeKey } from './lifecycle';

describe('micro-application runtime identity', () => {
  it('does not change when only localized presentation metadata changes', () => {
    const english = entry('00000000-0000-4000-8000-000000000201', 'Signal Board');
    const chinese = { ...english, name: '信号面板', summary: '隔离微应用' };

    expect(runtimeReleaseKey(chinese)).toBe(runtimeReleaseKey(english));
    expect(
      runtimeScopeKey(
        chinese,
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000010',
      ),
    ).toBe(
      runtimeScopeKey(
        english,
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000010',
      ),
    );
  });

  it('changes for a release, workspace, or principal authorization boundary', () => {
    const current = entry('00000000-0000-4000-8000-000000000201', 'Signal Board');
    const nextRelease = entry('00000000-0000-4000-8000-000000000202', 'Signal Board');
    const currentKey = runtimeScopeKey(
      current,
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000010',
    );

    expect(
      runtimeScopeKey(
        nextRelease,
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000010',
      ),
    ).not.toBe(currentKey);
    expect(
      runtimeScopeKey(
        current,
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000011',
      ),
    ).not.toBe(currentKey);
    expect(
      runtimeScopeKey(
        current,
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000010',
      ),
    ).not.toBe(currentKey);
  });
});

function entry(releaseId: string, name: string): CatalogEntry {
  return {
    applicationId: '00000000-0000-4000-8000-000000000101',
    name,
    releaseId,
  } as CatalogEntry;
}
