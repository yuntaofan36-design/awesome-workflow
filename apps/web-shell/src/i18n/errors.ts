import { ApiError } from '../services/http';

type Translate = (key: string, values?: Record<string, boolean | number | string | undefined>) => string;

const ERROR_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  auth_rate_limited: 'errors.authRateLimited',
  capability_denied: 'errors.capabilityDenied',
  forbidden: 'errors.forbidden',
  host_error: 'errors.hostError',
  http_error: 'errors.httpError',
  internal_error: 'errors.internal',
  invalid_credentials: 'errors.invalidCredentials',
  invalid_grant: 'errors.invalidGrant',
  invalid_request: 'errors.invalidRequest',
  invalid_state: 'errors.invalidState',
  local_auth_disabled: 'errors.localAuthDisabled',
  navigation_denied: 'errors.navigationDenied',
  not_authenticated: 'errors.notAuthenticated',
  not_found: 'errors.notFound',
  oidc_disabled: 'errors.oidcDisabled',
  operation_denied: 'errors.operationDenied',
  password_auth_disabled: 'errors.passwordAuthDisabled',
  provider_unavailable: 'errors.providerUnavailable',
  social_provider_disabled: 'errors.socialProviderDisabled',
  validation_failed: 'errors.validationFailed',
};

export type LocalizedError = { detail?: string; message: string };

export function localizeError(
  error: unknown,
  t: Translate,
  fallbackKey = 'errors.unexpected',
): LocalizedError {
  const detail = diagnosticDetail(error);
  const code = errorCode(error);
  const message = t((code && ERROR_MESSAGE_KEYS[code]) || fallbackKey);
  return { ...(detail && detail !== message ? { detail } : {}), message };
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.code;
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function diagnosticDetail(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : undefined;
}
