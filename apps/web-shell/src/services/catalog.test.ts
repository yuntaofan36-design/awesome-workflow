import { describe, expect, it } from 'vitest';

import { preserveCatalogForLocaleChange } from './catalog';

describe('localized catalog cache boundary', () => {
  const previous = [{ releaseId: 'release-1' }];

  it('keeps authorized data while only the locale query segment changes', () => {
    expect(
      preserveCatalogForLocaleChange(
        previous,
        ['catalog', 'workspace-1', 'stable', 'en-US'],
        'workspace-1',
        'stable',
      ),
    ).toBe(previous);
  });

  it('never carries catalog data across workspace or channel boundaries', () => {
    expect(
      preserveCatalogForLocaleChange(
        previous,
        ['catalog', 'workspace-1', 'stable', 'en-US'],
        'workspace-2',
        'stable',
      ),
    ).toBeUndefined();
    expect(
      preserveCatalogForLocaleChange(
        previous,
        ['catalog', 'workspace-1', 'canary', 'en-US'],
        'workspace-1',
        'stable',
      ),
    ).toBeUndefined();
  });
});
