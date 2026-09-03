import type { ReleaseChannelName } from '@awesome-workflow/contracts';
import type { ThemeSnapshot, UserSummary, WorkspaceSummary } from '@awesome-workflow/web-sdk';

import type { CatalogEntry } from './domain';

export const CHANNELS = ['dev', 'canary', 'stable'] as const satisfies readonly ReleaseChannelName[];

export type Identity = { theme: ThemeSnapshot; user: UserSummary; workspace: WorkspaceSummary };
export type CatalogMatrix = Record<ReleaseChannelName, CatalogEntry[]>;
export type Notify = (message: string) => void;
