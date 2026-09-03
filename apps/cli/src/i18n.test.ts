import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLI_MESSAGES,
  cliText,
  extractLocaleArgument,
  getCliLocale,
  problemText,
  resolveCliLocale,
  runWithCliLocale,
} from './i18n.js';

test('locale resolution follows --locale, AW_LOCALE, operating-system locale, then en-US', () => {
  assert.equal(resolveCliLocale('zh-CN', { AW_LOCALE: 'en-US' }, 'en-US'), 'zh-CN');
  assert.equal(resolveCliLocale(undefined, { AW_LOCALE: 'zh_CN' }, 'en-US'), 'zh-CN');
  assert.equal(resolveCliLocale(undefined, {}, 'zh-Hans-CN'), 'zh-CN');
  assert.equal(resolveCliLocale(undefined, {}, 'fr-FR'), 'en-US');
});

test('locale arguments are global but never consume aw dev child-process arguments', () => {
  assert.deepEqual(extractLocaleArgument(['--locale=zh-CN', 'status']), {
    argv: ['status'],
    requestedLocale: 'zh-CN',
  });
  assert.deepEqual(extractLocaleArgument(['dev', '--', 'tool', '--locale', 'zh-CN']), {
    argv: ['dev', '--', 'tool', '--locale', 'zh-CN'],
  });
});

test('English and Simplified Chinese CLI resources have identical stable keys', () => {
  assert.deepEqual(Object.keys(CLI_MESSAGES['zh-CN']).sort(), Object.keys(CLI_MESSAGES['en-US']).sort());
});

test('parallel CLI operations retain independent locale contexts', async () => {
  const chinese = runWithCliLocale('zh-CN', async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { locale: getCliLocale(), message: cliText('archive.empty') };
  });
  const english = runWithCliLocale('en-US', async () => {
    await Promise.resolve();
    return { locale: getCliLocale(), message: cliText('archive.empty') };
  });

  assert.deepEqual(await Promise.all([chinese, english]), [
    { locale: 'zh-CN', message: '打包输入目录不包含任何普通文件。' },
    {
      locale: 'en-US',
      message: 'Package input directory does not contain any regular files.',
    },
  ]);
});

test('RFC Problem codes are localized while remaining visible for support', () => {
  assert.equal(
    runWithCliLocale('zh-CN', () => problemText('internal_error', 'English server detail')),
    '服务器无法完成该请求 [internal_error]',
  );
});
