import { describe, expect, it } from 'vitest';

import { shellResources } from './messages';

describe('web shell translations', () => {
  it('keeps en-US and zh-CN message keys in lockstep', () => {
    expect(messageKeys(shellResources['zh-CN'].translation)).toEqual(
      messageKeys(shellResources['en-US'].translation),
    );
  });

  it('covers provider, locale, runtime and error labels in both locales', () => {
    for (const locale of ['en-US', 'zh-CN'] as const) {
      const messages = shellResources[locale].translation;
      expect(messages.locale.system).toBeTruthy();
      expect(messages.auth.provider.password).toBeTruthy();
      expect(messages.runtime.federationRejected).toBeTruthy();
      expect(messages.errors.internal).toBeTruthy();
    }
  });
});

function messageKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value)
    .flatMap(([key, child]) => messageKeys(child, prefix ? `${prefix}.${key}` : key))
    .sort();
}
