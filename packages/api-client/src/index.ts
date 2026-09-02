import createClient, { type ClientOptions } from 'openapi-fetch';

import type { paths } from './schema.js';

export type { components, operations, paths } from './schema.js';

export function createAwesomeWorkflowClient(options: ClientOptions = {}) {
  return createClient<paths>({
    baseUrl: '/api/v1',
    credentials: 'include',
    ...options,
  });
}
