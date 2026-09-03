import { resolveLocalizedContent } from '@awesome-workflow/i18n';
import { describe, expect, it } from 'vitest';

import { ApiProblemError } from './api';
import {
  applyControlPlaneDocumentLocale,
  controlPlaneResources,
  createControlPlaneI18n,
  translateControlPlaneError,
} from './i18n';

describe('control-plane internationalization', () => {
  it('keeps the English and Simplified Chinese catalogs structurally identical', () => {
    expect(messageKeys(controlPlaneResources['zh-CN'].translation)).toEqual(
      messageKeys(controlPlaneResources['en-US'].translation),
    );
  });

  it('translates stable RFC Problem codes and keeps the code visible for support', async () => {
    const instance = await createControlPlaneI18n('zh-CN');
    const error = new ApiProblemError(500, {
      code: 'internal_error',
      detail: 'The server could not complete the request',
    });

    expect(translateControlPlaneError(instance, error)).toBe('服务端无法完成该请求。 [internal_error]');
  });

  it('falls back to publisher content in the application default locale', () => {
    const content = resolveLocalizedContent(
      { name: 'Canonical name', summary: 'Canonical summary' },
      { 'zh-CN': { name: '中文名称', summary: '中文简介' } },
      'en-US',
      ['zh-CN'],
    );

    expect(content).toEqual({ name: '中文名称', summary: '中文简介' });
  });

  it('does not replace the shell title when mounted as a Federation remote', async () => {
    const instance = await createControlPlaneI18n('zh-CN');
    const target = {
      documentElement: { dir: '', lang: '' },
      title: 'Applications · Awesome Workflow',
    } as unknown as Document;

    applyControlPlaneDocumentLocale(
      instance,
      {
        direction: 'ltr',
        fallbackLocales: ['en-US'],
        locale: 'zh-CN',
        timeZone: 'Asia/Shanghai',
      },
      target,
      { ownsTitle: false },
    );

    expect(target.documentElement.lang).toBe('zh-CN');
    expect(target.documentElement.dir).toBe('ltr');
    expect(target.title).toBe('Applications · Awesome Workflow');
  });

  it('owns the document title in standalone mode', async () => {
    const instance = await createControlPlaneI18n('zh-CN');
    const target = {
      documentElement: { dir: '', lang: '' },
      title: 'Loading',
    } as unknown as Document;

    applyControlPlaneDocumentLocale(
      instance,
      {
        direction: 'ltr',
        fallbackLocales: ['en-US'],
        locale: 'zh-CN',
        timeZone: 'Asia/Shanghai',
      },
      target,
    );

    expect(target.title).toBe('Awesome Workflow · 控制平面');
  });
});

function messageKeys(source: object, prefix = ''): string[] {
  return Object.entries(source)
    .flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof value === 'object' && value !== null ? messageKeys(value, path) : [path];
    })
    .sort();
}
