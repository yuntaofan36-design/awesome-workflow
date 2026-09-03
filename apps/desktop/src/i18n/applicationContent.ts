import { resolveLocalizedContent } from '@awesome-workflow/i18n';

import type { DesktopLocaleSnapshot } from './runtime';

export type ApplicationLocalizations = Partial<
  Record<'en-US' | 'zh-CN', { name?: string; summary?: string; description?: string }>
>;

export type LocalizableApplication = {
  name: string;
  summary?: string;
  description?: string;
  defaultLocale: 'en-US' | 'zh-CN';
};

export function resolveDesktopApplicationContent<T extends LocalizableApplication>(
  source: T,
  localizations: ApplicationLocalizations | undefined,
  snapshot: DesktopLocaleSnapshot,
): T {
  return resolveLocalizedContent(source, localizations, snapshot.locale, [
    source.defaultLocale,
    ...snapshot.fallbackLocales,
  ]);
}
