import { describe, expect, it } from 'vitest';

import { resolveInitialShellLocale } from './shellStore';

const environment = {
  languages: ['en-US'],
  storage: { getItem: () => 'en-US', setItem: () => undefined },
  timeZone: 'Asia/Shanghai',
};

describe('Shell startup locale', () => {
  it('lets a validated CLI login locale override browser and persisted preferences for this page load', () => {
    expect(resolveInitialShellLocale(environment, '?cliRequestId=request&locale=zh-CN')).toEqual({
      preference: 'zh-CN',
      snapshot: {
        direction: 'ltr',
        fallbackLocales: ['en-US'],
        locale: 'zh-CN',
        timeZone: 'Asia/Shanghai',
      },
    });
  });

  it('ignores an unsupported query locale', () => {
    expect(resolveInitialShellLocale(environment, '?locale=fr-FR').preference).toBe('en-US');
  });
});
