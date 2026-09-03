import { z } from 'zod';

/**
 * Locales with first-party platform translations. Keep this list deliberately
 * small: accepting an arbitrary BCP 47 tag here would imply that the platform
 * ships a complete message catalog for it.
 */
export const SupportedLocaleSchema = z.enum(['en-US', 'zh-CN']);
export type SupportedLocale = z.infer<typeof SupportedLocaleSchema>;

export const LocalePreferenceSchema = z.union([z.literal('system'), SupportedLocaleSchema]);
export type LocalePreference = z.infer<typeof LocalePreferenceSchema>;

export const TextDirectionSchema = z.enum(['ltr', 'rtl']);
export type TextDirection = z.infer<typeof TextDirectionSchema>;

/** Locale context shared with a micro-application. It never contains messages or credentials. */
export const LocaleSnapshotSchema = z.object({
  locale: SupportedLocaleSchema,
  fallbackLocales: z.array(SupportedLocaleSchema).max(2),
  direction: TextDirectionSchema,
  timeZone: z.string().min(1).max(120),
});
export type LocaleSnapshot = z.infer<typeof LocaleSnapshotSchema>;

export const LocalizedApplicationContentSchema = z
  .object({
    name: z.string().min(2).max(80).optional(),
    summary: z.string().max(240).optional(),
    description: z.string().max(240).optional(),
  })
  .strict();
export type LocalizedApplicationContent = z.infer<typeof LocalizedApplicationContentSchema>;

/**
 * Optional publisher-authored content. The existing name/summary/description
 * remains the canonical fallback, so older clients and records stay valid.
 */
export const ApplicationLocalizationsSchema = z
  .object({
    'en-US': LocalizedApplicationContentSchema.optional(),
    'zh-CN': LocalizedApplicationContentSchema.optional(),
  })
  .strict()
  .default({});
export type ApplicationLocalizations = z.infer<typeof ApplicationLocalizationsSchema>;
