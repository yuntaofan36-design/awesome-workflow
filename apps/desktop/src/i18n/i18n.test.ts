import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppI18n, createLocaleSnapshot, formatDateTime, formatNumber } from '@awesome-workflow/i18n';

import { resolveDesktopApplicationContent } from './applicationContent';
import { formatUiError, normalizeUiError } from './errors';
import type { Translate } from './localeContext';
import { createLocaleSyncWarningGate, synchronizeAgentLocaleWithRetry } from './localeSync';
import { createLocaleTransitionQueue } from './localeTransition';
import { desktopResources } from './resources';

type CatalogValue = string | { readonly [key: string]: CatalogValue };

test('desktop catalogs contain the same non-empty keys and interpolation variables', () => {
  const english = flattenCatalog(desktopResources['en-US'].translation);
  const chinese = flattenCatalog(desktopResources['zh-CN'].translation);

  assert.deepEqual([...english.keys()].sort(), [...chinese.keys()].sort());
  for (const [key, englishValue] of english) {
    const chineseValue = chinese.get(key);
    assert.equal(typeof chineseValue, 'string', `missing zh-CN value for ${key}`);
    assert.notEqual(englishValue.trim(), '', `empty en-US value for ${key}`);
    assert.notEqual(chineseValue!.trim(), '', `empty zh-CN value for ${key}`);
    assert.deepEqual(
      interpolationVariables(englishValue),
      interpolationVariables(chineseValue!),
      `interpolation variables differ for ${key}`,
    );
  }
});

test('known and unknown desktop errors never render their raw diagnostic detail', async () => {
  const i18n = await createAppI18n(desktopResources, 'en-US');
  const t: Translate = (key, values) => String(i18n.t(key, values));
  const secretDiagnostic = 'database failed with password=must-not-render';

  const known = normalizeUiError({
    code: 'invalid_credentials',
    status: 401,
    detail: secretDiagnostic,
  });
  assert.equal(known.diagnostic, secretDiagnostic);
  assert.equal(formatUiError(known, t), 'The email or password is incorrect.');
  assert.ok(!formatUiError(known, t).includes(secretDiagnostic));

  const unknown = normalizeUiError(
    JSON.stringify({ code: 'vendor_internal_failure', detail: secretDiagnostic }),
  );
  assert.equal(unknown.diagnostic, secretDiagnostic);
  assert.equal(formatUiError(unknown, t), 'The operation could not be completed. Please try again.');
  assert.ok(!formatUiError(unknown, t).includes(secretDiagnostic));
});

test('publisher content falls back per field and locale-aware formatters use the frozen snapshot', () => {
  const snapshot = createLocaleSnapshot('en-US', { timeZone: 'Asia/Shanghai' });
  assert.deepEqual(
    resolveDesktopApplicationContent(
      {
        name: 'Default name',
        description: 'Default description',
        defaultLocale: 'zh-CN',
      },
      {
        'en-US': { name: 'English name' },
        'zh-CN': { description: '中文默认描述' },
      },
      snapshot,
    ),
    {
      name: 'English name',
      description: '中文默认描述',
      defaultLocale: 'zh-CN',
    },
  );

  const chineseSnapshot = createLocaleSnapshot('zh-CN', { timeZone: 'Asia/Shanghai' });
  assert.equal(formatNumber(12345.6, chineseSnapshot), new Intl.NumberFormat('zh-CN').format(12345.6));
  assert.equal(
    formatDateTime('2026-09-02T00:00:00Z', chineseSnapshot),
    new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Shanghai',
    }).format(new Date('2026-09-02T00:00:00Z')),
  );
});

test('Agent locale sync warnings repeat only after recovery or a different locale', () => {
  const gate = createLocaleSyncWarningGate();
  const chinese = createLocaleSnapshot('zh-CN');
  const english = createLocaleSnapshot('en-US');

  assert.equal(gate.failed(chinese), true);
  assert.equal(gate.failed(chinese), false);
  assert.equal(gate.failed(english), true);
  assert.equal(gate.failed(english), false);
  gate.succeeded();
  assert.equal(gate.failed(english), true);
});

test('Agent locale sync retries are bounded and stop after recovery', async () => {
  const snapshot = createLocaleSnapshot('zh-CN');
  const waits: number[] = [];
  let attempts = 0;
  await synchronizeAgentLocaleWithRetry(snapshot, {
    synchronize: async () => {
      attempts += 1;
      if (attempts < 3) throw { code: 'locale_sync_failed' };
      return { locale: 'zh-CN', fallbackLocales: ['en-US'] };
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [250, 1_000]);

  attempts = 0;
  await assert.rejects(
    synchronizeAgentLocaleWithRetry(snapshot, {
      synchronize: async () => {
        attempts += 1;
        throw { code: 'locale_sync_failed' };
      },
      wait: async () => undefined,
    }),
  );
  assert.equal(attempts, 3);
});

test('locale transitions serialize mutations and only commit the newest preference', async () => {
  const transitions = createLocaleTransitionQueue();
  const events: string[] = [];
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = transitions.run(
    async () => {
      events.push('first-transition');
      markFirstStarted();
      await firstGate;
    },
    () => events.push('first-commit'),
  );
  const second = transitions.run(
    async () => {
      events.push('second-transition');
    },
    () => events.push('second-commit'),
  );

  await firstStarted;
  assert.deepEqual(events, ['first-transition']);
  releaseFirst();
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.deepEqual(events, ['first-transition', 'second-transition', 'second-commit']);
});

function flattenCatalog(
  value: CatalogValue,
  prefix = '',
  entries = new Map<string, string>(),
): Map<string, string> {
  if (typeof value === 'string') {
    entries.set(prefix, value);
    return entries;
  }
  for (const [key, child] of Object.entries(value)) {
    flattenCatalog(child, prefix ? `${prefix}.${key}` : key, entries);
  }
  return entries;
}

function interpolationVariables(value: string): string[] {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)].map((match) => match[1]!).sort();
}
