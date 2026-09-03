import { describe, expect, it } from 'vitest';

import { ApiError } from '../services/http';
import { localizeError } from './errors';

const t = (key: string) => `translated:${key}`;

describe('localized errors', () => {
  it('uses a stable Problem Details code for the primary message and retains diagnostics', () => {
    expect(localizeError(new ApiError('database connection refused', 500, 'internal_error'), t)).toEqual({
      detail: 'database connection refused',
      message: 'translated:errors.internal',
    });
  });

  it('uses a localized fallback for an unknown error', () => {
    expect(localizeError(new Error('opaque failure'), t)).toEqual({
      detail: 'opaque failure',
      message: 'translated:errors.unexpected',
    });
  });
});
