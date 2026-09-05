import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { ReleaseManifestSchema } from '@awesome-workflow/manifest-schema';
import type { ReleaseChannelName } from '@awesome-workflow/contracts';

import { ApiClient, type FetchLike } from './api-client.js';
import { interactiveLogin, workloadLogin } from './auth.js';
import { loadCredential } from './credentials.js';
import { promoteRelease, publishPackagedRelease, releaseStatus } from './control-plane.js';
import { initializeManifest, packageRelease, readArtifactInputMap } from './package-release.js';
import { CliError, SecretRedactor, type TextWriter, requireEnvironmentSecret, writeLine } from './safety.js';
import { cliText, extractLocaleArgument, resolveCliLocale, runWithCliLocale } from './i18n.js';
import { normalizeLocale } from '@awesome-workflow/i18n';

export type CliRuntime = {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  stdout: TextWriter;
  stderr: TextWriter;
  fetchImpl: FetchLike;
  openBrowser?: (url: string) => Promise<void>;
};

const DEFAULT_API = 'http://127.0.0.1:3000';

export async function runCli(argv: readonly string[], overrides: Partial<CliRuntime> = {}): Promise<number> {
  const runtime: CliRuntime = {
    cwd: overrides.cwd ?? process.cwd(),
    environment: overrides.environment ?? process.env,
    stdout: overrides.stdout ?? ((text) => process.stdout.write(text)),
    stderr: overrides.stderr ?? ((text) => process.stderr.write(text)),
    fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
    ...(overrides.openBrowser ? { openBrowser: overrides.openBrowser } : {}),
  };
  const localizedArguments = extractLocaleArgument(argv);
  const locale = resolveCliLocale(localizedArguments.requestedLocale, runtime.environment);
  return runWithCliLocale(locale, () => runLocalizedCli(localizedArguments, runtime));
}

async function runLocalizedCli(
  localizedArguments: ReturnType<typeof extractLocaleArgument>,
  runtime: CliRuntime,
): Promise<number> {
  const redactor = new SecretRedactor();
  try {
    if (localizedArguments.error) throw new CliError(cliText(`locale.${localizedArguments.error}`), 2);
    if (localizedArguments.requestedLocale && !normalizeLocale(localizedArguments.requestedLocale)) {
      throw new CliError(cliText('locale.unsupported', { locale: localizedArguments.requestedLocale }), 2);
    }
    const command = localizedArguments.argv[0];
    const args = localizedArguments.argv.slice(1);
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      writeLine(runtime.stdout, cliText('help'));
      return 0;
    }
    switch (command) {
      case 'login':
        await loginCommand(args, runtime, redactor);
        return 0;
      case 'init':
        await initCommand(args, runtime);
        return 0;
      case 'dev':
        return devCommand(args, runtime);
      case 'package':
        await packageCommand(args, runtime, redactor);
        return 0;
      case 'publish':
        await publishCommand(args, runtime, redactor);
        return 0;
      case 'promote':
        await promoteCommand(args, runtime, redactor);
        return 0;
      case 'status':
        await statusCommand(args, runtime, redactor);
        return 0;
      default:
        throw new CliError(cliText('command.unknown', { command }), 2);
    }
  } catch (error) {
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    writeLine(runtime.stderr, `aw: ${redactor.clean(error)}`);
    return exitCode;
  }
}

async function loginCommand(
  args: readonly string[],
  runtime: CliRuntime,
  redactor: SecretRedactor,
): Promise<void> {
  const values = parseCommandArgs(args, {
    api: { type: 'string' },
    'ci-oidc-env': { type: 'string' },
    'config-dir': { type: 'string' },
    'timeout-seconds': { type: 'string' },
  });
  const apiBaseUrl = stringOption(values, 'api') ?? runtime.environment.AW_API_BASE_URL ?? DEFAULT_API;
  const configDir = resolveOptional(runtime.cwd, stringOption(values, 'config-dir'));
  const oidcEnvironmentName = stringOption(values, 'ci-oidc-env');
  const session = oidcEnvironmentName
    ? await workloadLogin({
        apiBaseUrl,
        environment: runtime.environment,
        oidcEnvironmentName,
        fetchImpl: runtime.fetchImpl,
        configDir,
        redactor,
      })
    : await interactiveLogin({
        apiBaseUrl,
        environment: runtime.environment,
        fetchImpl: runtime.fetchImpl,
        configDir,
        timeoutMs: parsePositiveSeconds(stringOption(values, 'timeout-seconds')) * 1_000,
        openBrowser: runtime.openBrowser,
        redactor,
      });
  writeLine(
    runtime.stdout,
    cliText('success.authenticated', { email: session.user.email, expiresAt: session.expiresAt }),
  );
}

async function initCommand(args: readonly string[], runtime: CliRuntime): Promise<void> {
  const values = parseCommandArgs(args, {
    kind: { type: 'string' },
    'app-id': { type: 'string' },
    name: { type: 'string' },
    output: { type: 'string' },
  });
  const kind = requiredStringOption(values, 'kind');
  if (kind !== 'web' && kind !== 'desktop') throw new CliError(cliText('error.kind'), 2);
  const appId = requiredStringOption(values, 'app-id');
  const outputPath = resolve(runtime.cwd, stringOption(values, 'output') ?? 'awesome-workflow.manifest.json');
  const manifest = await initializeManifest({ kind, appId, name: stringOption(values, 'name'), outputPath });
  writeLine(
    runtime.stdout,
    cliText(manifest.kind === 'web' ? 'success.manifestCreated' : 'success.desktopManifestCreated', {
      kind: manifest.kind,
      path: outputPath,
    }),
  );
}

async function devCommand(args: readonly string[], runtime: CliRuntime): Promise<number> {
  const delimiter = args.indexOf('--');
  if (delimiter < 0) throw new CliError(cliText('error.devDelimiter'), 2);
  const values = parseCommandArgs(args.slice(0, delimiter), {
    manifest: { type: 'string' },
    cwd: { type: 'string' },
  });
  const childArgs = args.slice(delimiter + 1);
  const executable = childArgs[0];
  if (!executable) throw new CliError(cliText('error.devEmpty'), 2);
  const workingDirectory = resolve(runtime.cwd, stringOption(values, 'cwd') ?? '.');
  const manifestPath = resolve(
    workingDirectory,
    stringOption(values, 'manifest') ?? 'awesome-workflow.manifest.json',
  );
  await validateManifest(manifestPath);
  return spawnCommand(executable, childArgs.slice(1), workingDirectory, runtime.environment);
}

async function packageCommand(
  args: readonly string[],
  runtime: CliRuntime,
  redactor: SecretRedactor,
): Promise<void> {
  const values = parseCommandArgs(args, {
    manifest: { type: 'string' },
    input: { type: 'string' },
    output: { type: 'string' },
    'key-id': { type: 'string' },
    'private-key': { type: 'string' },
    'private-key-env': { type: 'string' },
    'artifact-name': { type: 'string' },
    'artifact-map': { type: 'string' },
  });
  const artifactMapPath = resolveOptional(runtime.cwd, stringOption(values, 'artifact-map'));
  const inputOption = stringOption(values, 'input');
  const artifactName = stringOption(values, 'artifact-name');
  if (artifactMapPath && (inputOption || artifactName)) {
    throw new CliError(cliText('error.artifactMapConflict'), 2);
  }
  const result = await packageRelease({
    manifestPath: resolve(runtime.cwd, stringOption(values, 'manifest') ?? 'awesome-workflow.manifest.json'),
    ...(artifactMapPath
      ? { artifactInputs: await readArtifactInputMap(artifactMapPath) }
      : { inputDirectory: resolve(runtime.cwd, inputOption ?? 'dist') }),
    outputDirectory: resolve(runtime.cwd, stringOption(values, 'output') ?? '.aw'),
    keyId: stringOption(values, 'key-id'),
    privateKeyPath: resolveOptional(runtime.cwd, stringOption(values, 'private-key')),
    privateKeyEnvironmentName: stringOption(values, 'private-key-env'),
    artifactName,
    environment: runtime.environment,
    redactor,
  });
  const artifactSummary = result.artifacts
    .map((artifact) =>
      cliText('success.artifactSummary', {
        name: artifact.name,
        fileName: artifact.fileName,
        size: artifact.size,
        sha256: artifact.sha256,
      }),
    )
    .join('; ');
  writeLine(
    runtime.stdout,
    cliText('success.packaged', {
      count: result.artifacts.length,
      summary: artifactSummary,
      path: result.metadataPath,
    }),
  );
}

async function publishCommand(
  args: readonly string[],
  runtime: CliRuntime,
  redactor: SecretRedactor,
): Promise<void> {
  const values = parseCommandArgs(
    args,
    networkOptions({
      'application-id': { type: 'string' },
      package: { type: 'string' },
    }),
  );
  const api = await authenticatedApi(values, runtime, redactor);
  const summary = await publishPackagedRelease({
    api,
    applicationId: requiredUuidOption(values, 'application-id'),
    metadataPath: resolve(runtime.cwd, stringOption(values, 'package') ?? '.aw/package.json'),
  });
  writeLine(runtime.stdout, JSON.stringify(summary, null, 2));
}

async function promoteCommand(
  args: readonly string[],
  runtime: CliRuntime,
  redactor: SecretRedactor,
): Promise<void> {
  const values = parseCommandArgs(
    args,
    networkOptions({
      'application-id': { type: 'string' },
      'release-id': { type: 'string' },
      channel: { type: 'string' },
      'expected-current-release-id': { type: 'string' },
      'expected-none': { type: 'boolean' },
      'workspace-id': { type: 'string' },
    }),
  );
  const expectedId = stringOption(values, 'expected-current-release-id');
  const expectedNone = booleanOption(values, 'expected-none');
  if (expectedId && expectedNone) throw new CliError(cliText('error.expectedConflict'), 2);
  const channel = requiredStringOption(values, 'channel');
  if (!['dev', 'canary', 'stable'].includes(channel)) throw new CliError(cliText('error.channel'), 2);
  const api = await authenticatedApi(values, runtime, redactor);
  const summary = await promoteRelease({
    api,
    applicationId: requiredUuidOption(values, 'application-id'),
    releaseId: requiredUuidOption(values, 'release-id'),
    channel: channel as ReleaseChannelName,
    ...(expectedId
      ? { expectedCurrentReleaseId: assertUuid(expectedId, '--expected-current-release-id') }
      : {}),
    ...(expectedNone ? { expectedCurrentReleaseId: null } : {}),
    ...(stringOption(values, 'workspace-id')
      ? { workspaceId: assertUuid(stringOption(values, 'workspace-id')!, '--workspace-id') }
      : {}),
  });
  writeLine(runtime.stdout, JSON.stringify(summary, null, 2));
}

async function statusCommand(
  args: readonly string[],
  runtime: CliRuntime,
  redactor: SecretRedactor,
): Promise<void> {
  const values = parseCommandArgs(args, networkOptions({ 'release-id': { type: 'string' } }));
  const api = await authenticatedApi(values, runtime, redactor);
  const summary = await releaseStatus({ api, releaseId: requiredUuidOption(values, 'release-id') });
  writeLine(runtime.stdout, JSON.stringify(summary, null, 2));
}

async function authenticatedApi(
  values: Record<string, string | boolean | undefined>,
  runtime: CliRuntime,
  redactor: SecretRedactor,
): Promise<ApiClient> {
  const apiBaseUrl = stringOption(values, 'api') ?? runtime.environment.AW_API_BASE_URL ?? DEFAULT_API;
  const tokenEnvironmentName = stringOption(values, 'token-env');
  let accessToken: string;
  if (tokenEnvironmentName) {
    accessToken = requireEnvironmentSecret(tokenEnvironmentName, runtime.environment, redactor);
  } else {
    const credential = await loadCredential(apiBaseUrl, {
      environment: runtime.environment,
      configDir: resolveOptional(runtime.cwd, stringOption(values, 'config-dir')),
    });
    accessToken = credential.accessToken;
    redactor.add(accessToken);
  }
  return new ApiClient(apiBaseUrl, accessToken, runtime.fetchImpl, redactor);
}

function networkOptions<T extends Record<string, { type: 'string' | 'boolean' }>>(
  options: T,
): T & {
  api: { type: 'string' };
  'token-env': { type: 'string' };
  'config-dir': { type: 'string' };
} {
  return {
    ...options,
    api: { type: 'string' },
    'token-env': { type: 'string' },
    'config-dir': { type: 'string' },
  };
}

function parseCommandArgs(
  args: readonly string[],
  options: Record<string, { type: 'string' | 'boolean' }>,
): Record<string, string | boolean | undefined> {
  try {
    const parsed = parseArgs({ args: [...args], options, allowPositionals: false, strict: true });
    return parsed.values;
  } catch {
    throw new CliError(cliText('error.arguments'), 2);
  }
}

function stringOption(
  values: Record<string, string | boolean | undefined>,
  name: string,
): string | undefined {
  const value = values[name];
  return typeof value === 'string' && value ? value : undefined;
}

function booleanOption(values: Record<string, string | boolean | undefined>, name: string): boolean {
  return values[name] === true;
}

function requiredStringOption(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = stringOption(values, name);
  if (!value) throw new CliError(cliText('error.requiredOption', { name }), 2);
  return value;
}

function requiredUuidOption(values: Record<string, string | boolean | undefined>, name: string): string {
  return assertUuid(requiredStringOption(values, name), `--${name}`);
}

function assertUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new CliError(cliText('error.uuid', { label }), 2);
  }
  return value;
}

function resolveOptional(cwd: string, value: string | undefined): string | undefined {
  return value ? resolve(cwd, value) : undefined;
}

function parsePositiveSeconds(value: string | undefined): number {
  if (!value) return 120;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 600) {
    throw new CliError(cliText('error.timeout'), 2);
  }
  return seconds;
}

async function validateManifest(path: string): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new CliError(cliText('error.manifestMissing', { path }));
  }
  const parsed = ReleaseManifestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CliError(
      issue
        ? cliText('error.manifestValidationAt', {
            path: issue.path.join('.') || '/',
            code: issue.code,
          })
        : cliText('error.manifestValidation'),
    );
  }
}

async function spawnCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  const command =
    process.platform === 'win32' && ['npm', 'npx', 'pnpm', 'yarn'].includes(executable)
      ? `${executable}.cmd`
      : executable;
  return new Promise<number>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: environment,
      shell: false,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', () => reject(new CliError(cliText('error.spawn', { command: executable }))));
    child.once('exit', (code, signal) => {
      if (signal) reject(new CliError(cliText('error.signal', { signal })));
      else resolvePromise(code ?? 1);
    });
  });
}
