import { WorkspaceSchema, type Workspace } from '@awesome-workflow/contracts';

import { apiRequest } from './http';

export async function getWorkspaces(): Promise<Workspace[]> {
  const response = await apiRequest<unknown>('/workspaces');
  if (!isRecord(response) || !Array.isArray(response.data))
    throw new Error('Workspace response must contain a data array');
  return WorkspaceSchema.array().parse(response.data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
