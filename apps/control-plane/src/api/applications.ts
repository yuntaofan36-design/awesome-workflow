import {
  ApplicationSchema,
  type Application,
  type ApplicationLocalizations,
  type SupportedLocale,
} from '@awesome-workflow/contracts';

import { isRecord, request } from '../apiClient';

export async function createWebApplication(input: {
  defaultLocale: SupportedLocale;
  localizations: ApplicationLocalizations;
  name: string;
  slug: string;
  summary: string;
  workspaceId: string;
  locale?: SupportedLocale;
}): Promise<void> {
  await request(
    `/workspaces/${encodeURIComponent(input.workspaceId)}/applications`,
    {
      body: JSON.stringify({
        defaultLocale: input.defaultLocale,
        kind: 'web',
        localizations: input.localizations,
        name: input.name,
        slug: input.slug,
        summary: input.summary,
      }),
      method: 'POST',
    },
    input.locale,
  );
}

export async function listApplications(
  workspaceId: string,
  locale?: SupportedLocale,
): Promise<Application[]> {
  const body = await request<unknown>(
    `/workspaces/${encodeURIComponent(workspaceId)}/applications`,
    undefined,
    locale,
  );
  const data = isRecord(body) ? body.data : undefined;
  return ApplicationSchema.array().parse(data);
}
