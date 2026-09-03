import assert from 'node:assert/strict';
import test from 'node:test';

import { getDesktopRequestLocale, setDesktopRequestLocale } from './requestLocale';

test('desktop request locale changes synchronously', () => {
  setDesktopRequestLocale('zh-CN');
  assert.equal(getDesktopRequestLocale(), 'zh-CN');

  setDesktopRequestLocale('en-US');
  assert.equal(getDesktopRequestLocale(), 'en-US');
});
