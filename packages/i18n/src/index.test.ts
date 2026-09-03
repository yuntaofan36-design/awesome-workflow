import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLocaleSnapshot,
  detectBrowserLocale,
  formatBytes,
  normalizeLocale,
  resolveLocalizedContent,
  resolveLocale,
} from './index.js';

test('normalizes only locales with first-party catalogs', () => {
  assert.equal(normalizeLocale('zh-Hans-CN'), 'zh-CN');
  assert.equal(normalizeLocale('zh-TW'), 'zh-CN');
  assert.equal(normalizeLocale('zh-HK'), 'zh-CN');
  assert.equal(normalizeLocale('en_GB'), 'en-US');
  assert.equal(normalizeLocale('fr-FR'), null);
});

test('resolves system languages in browser preference order', () => {
  assert.equal(resolveLocale('system', ['fr-FR', 'zh-Hans']), 'zh-CN');
  assert.equal(resolveLocale('system', ['fr-FR']), 'en-US');
  assert.equal(resolveLocale('zh-CN', ['en-US']), 'zh-CN');
});

test('invalid persisted preference falls back to system detection', () => {
  const result = detectBrowserLocale({
    languages: ['zh-CN'],
    storage: { getItem: () => 'not-a-locale', setItem: () => undefined },
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(result.preference, 'system');
  assert.deepEqual(result.snapshot, {
    locale: 'zh-CN',
    fallbackLocales: ['en-US'],
    direction: 'ltr',
    timeZone: 'Asia/Shanghai',
  });
});

test('formats numbers and resolves publisher-authored localized content', () => {
  const snapshot = createLocaleSnapshot('zh-CN', { timeZone: 'Asia/Shanghai' });
  assert.equal(formatBytes(1536, snapshot), '1.5 KB');
  assert.deepEqual(
    resolveLocalizedContent(
      { name: 'Default', summary: 'Default summary' },
      { 'zh-CN': { name: '默认名称' } },
      'zh-CN',
    ),
    { name: '默认名称', summary: 'Default summary' },
  );
});
