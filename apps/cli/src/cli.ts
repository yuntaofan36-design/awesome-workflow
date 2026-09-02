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
  const redactor = new SecretRedactor();
  try {
    const command = argv[0];
    const args = argv.slice(1);
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      writeLine(runtime.stdout, HELP_TEXT);
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
        throw new CliError(`Unknown command: ${command}. Run \`aw help\` for usage.`, 2);
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
  writeLine(runtime.stdout, `Authenticated as ${session.user.email}; session expires ${session.expiresAt}.`);
}

async function initCommand(args: readonly string[], runtime: CliRuntime): Promise<void> {
  const values = parseCommandArgs(args, {
    kind: { type: 'string' },
    'app-id': { type: 'string' },
    name: { type: 'string' },
    output: { type: 'string' },
  });
  const kind = requiredStringOption(values, 'kind');
  if (kind !== 'web' && kind !== 'desktop') throw new CliError('--kind must be web or desktop.', 2);
  const appId = requiredStringOption(values, 'app-id');
  const outputPath = resolve(runtime.cwd, stringOption(values, 'output') ?? 'awesome-workflow.manifest.json');
  const manifest = await initializeManifest({ kind, appId, name: stringOption(values, 'name'), outputPath });
  writeLine(
    runtime.stdout,
    `Created ${manifest.kind} manifest ${outputPath}. Signing remains unconfigured until \`aw package\`.`,
  );
}

async function devCommand(args: readonly string[], runtime: CliRuntime): Promise<number> {
  const delimiter = args.indexOf('--');
  if (delimiter < 0)
    throw new CliError('`aw dev` requires a command after `--`, for example: aw dev -- pnpm dev.', 2);
  const values = parseCommandArgs(args.slice(0, delimiter), {
    manifest: { type: 'string' },
    cwd: { type: 'string' },
  });
  const childArgs = args.slice(delimiter + 1);
  const executable = childArgs[0];
  if (!executable) throw new CliError('`aw dev` command cannot be empty.', 2);
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
    throw new CliError('--artifact-map cannot be combined with --input or --artifact-name.', 2);
  }
  const result = await packageRelease({
    manifestPath: resolve(runtime.cwd, stringOption(values, 'manifest') ?? 'awesome-workflow.manifest.json'),
    ...(artifactMapPath
      ? { artifactInputs: await readArtifactInputMap(artifactMapPath) }
      : { inputDirectory: resolve(runtime.cwd, inputOption ?? 'dist') }),
    outputDirectory: resolve(runtime.cwd, stringOption(values, 'output') ?? '.aw'),
    keyId: requiredStringOption(values, 'key-id'),
    privateKeyPath: resolveOptional(runtime.cwd, stringOption(values, 'private-key')),
    privateKeyEnvironmentName: stringOption(values, 'private-key-env'),
    artifactName,
    environment: runtime.environment,
    redactor,
  });
  const artifactSummary = result.artifacts
    .map(
      (artifact) =>
        `${artifact.name}=${artifact.fileName} (${artifact.size} bytes, sha256 ${artifact.sha256})`,
    )
    .join('; ');
  writeLine(
    runtime.stdout,
    `Packaged ${result.artifacts.length} artifact(s): ${artifactSummary}. Metadata: ${result.metadataPath}`,
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
  if (expectedId && expectedNone)
    throw new CliError('Use only one of --expected-current-release-id and --expected-none.', 2);
  const channel = requiredStringOption(values, 'channel');
  if (!['dev', 'canary', 'stable'].includes(channel))
    throw new CliError('--channel must be dev, canary, or stable.', 2);
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
  const parsed = parseArgs({ args: [...args], options, allowPositionals: false, strict: true });
  return parsed.values;
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
  if (!value) throw new CliError(`Missing required option --${name}.`, 2);
  return value;
}

function requiredUuidOption(values: Record<string, string | boolean | undefined>, name: string): string {
  return assertUuid(requiredStringOption(values, name), `--${name}`);
}

function assertUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new CliError(`${label} must be a UUID.`, 2);
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
    throw new CliError('--timeout-seconds must be an integer from 5 to 600.', 2);
  }
  return seconds;
}

async function validateManifest(path: string): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new CliError(`Manifest is missing or is not valid JSON: ${path}`);
  }
  const parsed = ReleaseManifestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CliError(
      `Manifest validation failed${issue ? ` at ${issue.path.join('.') || '<root>'}: ${issue.message}` : '.'}`,
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
    child.once('error', () => reject(new CliError(`Unable to start development command: ${executable}`)));
    child.once('exit', (code, signal) => {
      if (signal) reject(new CliError(`Development command terminated by signal ${signal}.`));
      else resolvePromise(code ?? 1);
    });
  });
}

const HELP_TEXT = `Awesome Workflow CLI

Usage:
  aw login [--api URL] [--ci-oidc-env NAME]
  aw init --kind web|desktop --app-id SLUG [--name NAME] [--output FILE]
  aw dev [--manifest FILE] [--cwd DIR] -- COMMAND [ARG ...]
  aw package --key-id ID (--private-key FILE | --private-key-env NAME)
             [--manifest FILE] [--input DIR | --artifact-map FILE] [--output DIR]
  aw publish --application-id UUID [--package FILE] [--api URL] [--token-env NAME]
  aw promote --application-id UUID --release-id UUID --channel dev|canary|stable
             (--expected-current-release-id UUID | --expected-none | --workspace-id UUID)
  aw status --release-id UUID [--api URL] [--token-env NAME]

Security defaults:
  - login uses a 127.0.0.1 ephemeral callback, PKCE S256, and strict state validation;
  - private keys and tokens are never printed;
  - dev commands execute as an argv vector without a shell;
  - package emits a deterministic ZIP, CycloneDX and SPDX SBOMs, and Ed25519 signatures.`;
