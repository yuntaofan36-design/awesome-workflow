import assert from 'node:assert/strict';
import test from 'node:test';

import { KnownProblemCodeSchema } from '@awesome-workflow/contracts';

import { loginEmailContent, negotiateLocale, problemDetail } from './locale.js';

test('negotiates supported locales using quality and source order', () => {
  assert.equal(negotiateLocale('fr-FR, zh-Hans;q=0.8, en;q=0.5'), 'zh-CN');
  assert.equal(negotiateLocale('zh-TW, en;q=0.5'), 'zh-CN');
  assert.equal(negotiateLocale('zh-CN;q=0, en-GB;q=0.7'), 'en-US');
  assert.equal(negotiateLocale('unknown'), 'en-US');
});

test('keeps problem codes stable while localizing human detail', () => {
  assert.equal(problemDetail('zh-CN', 'invalid_credentials', undefined, 401), '邮箱或密码错误');
  assert.equal(problemDetail('en-US', 'custom_code', 'Diagnostic detail', 409), 'Diagnostic detail');
});

test('has a Chinese message for every stable platform problem code', () => {
  for (const code of KnownProblemCodeSchema.options) {
    assert.notEqual(
      problemDetail('zh-CN', code, '__untranslated__', 400),
      '__untranslated__',
      `missing zh-CN Problem Details message for ${code}`,
    );
  }
});

test('renders login mail in the negotiated locale', () => {
  const mail = loginEmailContent('zh-CN', '123456', 5);
  assert.match(mail.subject, /验证码/);
  assert.match(mail.text, /123456/);
});
