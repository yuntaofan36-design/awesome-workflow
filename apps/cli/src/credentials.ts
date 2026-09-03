import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { normalizeApiBase } from './api-client.js';
import { cliText } from './i18n.js';
import { CliError, isRecord } from './safety.js';

export type StoredCredential = {
  apiBaseUrl: string;
  accessToken: string;
  expiresAt: string;
};

export async function saveCredential(
  credential: StoredCredential,
  options: { environment?: NodeJS.ProcessEnv; configDir?: string } = {},
): Promise<string> {
  const directory = options.configDir ?? credentialDirectory(options.environment ?? process.env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await bestEffortChmod(directory, 0o700);
  const file = join(directory, 'session.json');
  await writeFile(
    file,
    `${JSON.stringify({ ...credential, apiBaseUrl: normalizeApiBase(credential.apiBaseUrl) }, null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  await bestEffortChmod(file, 0o600);
  return file;
}

export async function loadCredential(
  apiBaseUrl: string,
  options: { environment?: NodeJS.ProcessEnv; configDir?: string; now?: Date } = {},
): Promise<StoredCredential> {
  const directory = options.configDir ?? credentialDirectory(options.environment ?? process.env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new CliError(cliText('credential.missing'));
    }
    throw new CliError(cliText('credential.unreadable'));
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.apiBaseUrl !== 'string' ||
    typeof parsed.accessToken !== 'string' ||
    typeof parsed.expiresAt !== 'string'
  ) {
    throw new CliError(cliText('credential.invalid'));
  }
  if (normalizeApiBase(parsed.apiBaseUrl) !== normalizeApiBase(apiBaseUrl)) {
    throw new CliError(cliText('credential.differentServer'));
  }
  const expiresAt = new Date(parsed.expiresAt);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= (options.now ?? new Date()).getTime() + 30_000
  ) {
    throw new CliError(cliText('credential.expired'));
  }
  return { apiBaseUrl: parsed.apiBaseUrl, accessToken: parsed.accessToken, expiresAt: parsed.expiresAt };
}

export function credentialDirectory(environment: NodeJS.ProcessEnv): string {
  if (environment.AW_CONFIG_DIR) return environment.AW_CONFIG_DIR;
  if (process.platform === 'win32' && environment.APPDATA)
    return join(environment.APPDATA, 'awesome-workflow');
  return join(environment.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'awesome-workflow');
}

async function bestEffortChmod(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (!isNodeError(error) || !['ENOSYS', 'EPERM'].includes(error.code ?? '')) throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
