import type { Translate } from './localeContext';

export type UiError = {
  code: string;
  status?: number;
  diagnostic?: string;
};

const knownErrorCodes = new Set([
  'unknown_error',
  'endpoint_not_allowed',
  'desktop_required',
  'request_failed',
  'invalid_response',
  'internal_error',
  'unauthenticated',
  'invalid_credentials',
  'password_auth_disabled',
  'forbidden',
  'not_found',
  'rate_limited',
  'validation_error',
  'credential_unavailable',
  'invalid_credential',
  'invalid_auth_response',
  'auth_rejected',
  'invalid_api_base',
  'invalid_callback',
  'callback_timeout',
  'browser_unavailable',
  'response_too_large',
  'auth_transport_failed',
  'unsupported_platform',
  'unsupported_locale',
  'locale_sync_failed',
  'agent_snapshot_failed',
  'applet_validation_failed',
  'development_applet_registration_failed',
  'signed_package_install_failed',
  'applet_uninstall_failed',
  'applet_run_failed',
  'task_stop_failed',
  'task_log_read_failed',
  'schedule_apply_failed',
  'schedule_offline_failed',
  'session_restore_failed',
  'auth_providers_failed',
  'sign_in_failed',
  'sign_out_failed',
  'api_request_failed',
  'device_enrollment_failed',
  'device_name_invalid',
  'agent_already_enrolled',
  'web_ui_launch_failed',
  'updater_check_failed',
  'updater_download_failed',
  'updater_install_failed',
  'updater_restart_failed',
  'update_required_before_download',
  'updater_unavailable',
]);

const legacyMessages = new Map<string, string>([
  ['secure credential storage is unavailable', 'credential_unavailable'],
  ['the secure credential is invalid; sign in again', 'invalid_credential'],
  ['the authentication server returned an invalid response', 'invalid_auth_response'],
  ['the configured API URL is not allowed', 'invalid_api_base'],
  ['the authorization callback was rejected', 'invalid_callback'],
  ['timed out waiting for the browser authorization callback', 'callback_timeout'],
  ['unable to open the system browser', 'browser_unavailable'],
  ['authenticated API endpoint is not allowed', 'endpoint_not_allowed'],
  ['authenticated API response is too large', 'response_too_large'],
  ['authentication transport failed', 'auth_transport_failed'],
  [
    'authentication is not supported on this platform without a secure credential store',
    'unsupported_platform',
  ],
  ['unsupported desktop locale', 'unsupported_locale'],
  ['This desktop API endpoint is not allowed.', 'endpoint_not_allowed'],
  ['Authenticated API access requires the desktop host.', 'desktop_required'],
  ['Check for an update before downloading or installing it.', 'update_required_before_download'],
  ['Signed updates are unavailable in a browser preview.', 'updater_unavailable'],
]);

export function normalizeUiError(error: unknown, fallbackCode = 'unknown_error'): UiError {
  const record = asRecord(error);
  const status = numberValue(record?.status);
  const explicitCode = codeValue(record?.code) ?? codeValue(record?.errorCode);
  const diagnostic =
    stringValue(record?.diagnostic) ??
    stringValue(record?.detail) ??
    stringValue(record?.message) ??
    stringValue(record?.error) ??
    (typeof error === 'string' ? error : error instanceof Error ? error.message : undefined);
  const inferredCode = diagnostic ? inferLegacyCode(diagnostic) : undefined;
  return {
    code: explicitCode ?? inferredCode ?? fallbackCode,
    ...(status === undefined ? {} : { status }),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

export function formatUiError(error: UiError | null | undefined, t: Translate): string {
  if (!error) return '';
  const code = knownErrorCodes.has(error.code) ? error.code : 'unknown_error';
  return t(`errors.${code}`, {
    ...(error.status === undefined ? {} : { status: error.status }),
  });
}

function inferLegacyCode(message: string): string | undefined {
  const exact = legacyMessages.get(message);
  if (exact) return exact;
  if (/^the authentication request was rejected with status \d+$/.test(message)) {
    return 'auth_rejected';
  }
  if (/^Request failed with \d+$/.test(message)) return 'request_failed';
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trimStart().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function codeValue(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{1,80}$/.test(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, 2_048) : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}
