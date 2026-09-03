import { describe, expect, it } from 'vitest';

import { demoResources } from './i18n';

describe('demo web app translations', () => {
  it('keeps en-US and zh-CN message keys in lockstep', () => {
    expect(messageKeys(demoResources['zh-CN'].translation)).toEqual(
      messageKeys(demoResources['en-US'].translation),
    );
  });

  it('localizes the host notification instead of sending a fixed language', () => {
    expect(demoResources['en-US'].translation.notification.completed).not.toBe(
      demoResources['zh-CN'].translation.notification.completed,
    );
  });
});

function messageKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value)
    .flatMap(([key, child]) => messageKeys(child, prefix ? `${prefix}.${key}` : key))
    .sort();
}
