import { AsyncLocalStorage } from 'node:async_hooks';

import type { SupportedLocale } from '@awesome-workflow/contracts';
import { DEFAULT_LOCALE, normalizeLocale } from '@awesome-workflow/i18n';

export type MessageValues = Record<string, string | number>;

const localeContext = new AsyncLocalStorage<SupportedLocale>();

export function getCliLocale(): SupportedLocale {
  return localeContext.getStore() ?? DEFAULT_LOCALE;
}

export function runWithCliLocale<TResult>(locale: SupportedLocale, callback: () => TResult): TResult {
  return localeContext.run(locale, callback);
}

export function resolveCliLocale(
  requested: string | undefined,
  environment: NodeJS.ProcessEnv,
  systemLocale = Intl.DateTimeFormat().resolvedOptions().locale,
): SupportedLocale {
  const explicit = requested ?? environment.AW_LOCALE;
  if (explicit) return normalizeLocale(explicit) ?? DEFAULT_LOCALE;
  return normalizeLocale(systemLocale) ?? DEFAULT_LOCALE;
}

export function extractLocaleArgument(argv: readonly string[]): {
  argv: string[];
  requestedLocale?: string;
  error?: 'duplicate' | 'missing';
} {
  const clean: string[] = [];
  let requestedLocale: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--') {
      clean.push(...argv.slice(index));
      break;
    }
    let candidate: string | undefined;
    if (argument === '--locale') {
      candidate = argv[index + 1];
      if (!candidate || candidate.startsWith('-')) return { argv: clean, error: 'missing' };
      index += 1;
    } else if (argument.startsWith('--locale=')) {
      candidate = argument.slice('--locale='.length);
      if (!candidate) return { argv: clean, error: 'missing' };
    } else {
      clean.push(argument);
      continue;
    }
    if (requestedLocale !== undefined) return { argv: clean, error: 'duplicate' };
    requestedLocale = candidate;
  }
  return { argv: clean, ...(requestedLocale ? { requestedLocale } : {}) };
}

export function cliText(key: string, values: MessageValues = {}): string {
  const catalog = CLI_MESSAGES[getCliLocale()];
  const template = catalog[key] ?? CLI_MESSAGES[DEFAULT_LOCALE][key] ?? key;
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : `{${name}}`,
  );
}

export function problemText(code: string, fallback?: string): string {
  const key = `problem.${code}`;
  const translated = CLI_MESSAGES[getCliLocale()][key];
  const message = translated ?? fallback ?? cliText('problem.unknown');
  return code ? cliText('problem.withCode', { code, message }) : message;
}

const HELP_EN = `Awesome Workflow CLI

Usage:
  aw [--locale en-US|zh-CN] login [--api URL] [--ci-oidc-env NAME]
  aw [--locale en-US|zh-CN] init --kind web|desktop --app-id SLUG [--name NAME] [--output FILE]
  aw [--locale en-US|zh-CN] dev [--manifest FILE] [--cwd DIR] -- COMMAND [ARG ...]
  aw [--locale en-US|zh-CN] package --key-id ID (--private-key FILE | --private-key-env NAME)
             [--manifest FILE] [--input DIR | --artifact-map FILE] [--output DIR]
  aw [--locale en-US|zh-CN] publish --application-id UUID [--package FILE] [--api URL] [--token-env NAME]
  aw [--locale en-US|zh-CN] promote --application-id UUID --release-id UUID --channel dev|canary|stable
             (--expected-current-release-id UUID | --expected-none | --workspace-id UUID)
  aw [--locale en-US|zh-CN] status --release-id UUID [--api URL] [--token-env NAME]

Locale priority: --locale, AW_LOCALE, operating-system locale, then en-US.

Security defaults:
  - login uses a 127.0.0.1 ephemeral callback, PKCE S256, and strict state validation;
  - private keys and tokens are never printed;
  - dev commands execute as an argv vector without a shell;
  - package emits a deterministic ZIP, CycloneDX and SPDX SBOMs, and Ed25519 signatures.`;

const HELP_ZH = `Awesome Workflow CLI

用法：
  aw [--locale en-US|zh-CN] login [--api URL] [--ci-oidc-env NAME]
  aw [--locale en-US|zh-CN] init --kind web|desktop --app-id SLUG [--name NAME] [--output FILE]
  aw [--locale en-US|zh-CN] dev [--manifest FILE] [--cwd DIR] -- COMMAND [ARG ...]
  aw [--locale en-US|zh-CN] package --key-id ID (--private-key FILE | --private-key-env NAME)
             [--manifest FILE] [--input DIR | --artifact-map FILE] [--output DIR]
  aw [--locale en-US|zh-CN] publish --application-id UUID [--package FILE] [--api URL] [--token-env NAME]
  aw [--locale en-US|zh-CN] promote --application-id UUID --release-id UUID --channel dev|canary|stable
             (--expected-current-release-id UUID | --expected-none | --workspace-id UUID)
  aw [--locale en-US|zh-CN] status --release-id UUID [--api URL] [--token-env NAME]

语言优先级：--locale、AW_LOCALE、操作系统语言，最后回退到 en-US。

安全默认值：
  - 登录使用 127.0.0.1 临时回调、PKCE S256 和严格 state 校验；
  - 永不输出私钥和令牌；
  - 开发命令以 argv 数组直接执行，不经过 shell；
  - 打包输出确定性 ZIP、CycloneDX/SPDX SBOM 和 Ed25519 签名。`;

const enUS: Record<string, string> = {
  help: HELP_EN,
  'locale.missing': '--locale requires en-US or zh-CN.',
  'locale.duplicate': '--locale may be supplied only once.',
  'locale.unsupported': 'Unsupported locale: {locale}. Supported locales: en-US, zh-CN.',
  'command.unknown': 'Unknown command: {command}. Run `aw help` for usage.',
  'success.authenticated': 'Authenticated as {email}; session expires {expiresAt}.',
  'success.manifestCreated':
    'Created {kind} manifest {path}. Signing remains unconfigured until `aw package`.',
  'success.packaged': 'Packaged {count} artifact(s): {summary}. Metadata: {path}',
  'success.artifactSummary': '{name}={fileName} ({size} bytes, sha256 {sha256})',
  'manifest.desktopDescription': 'Desktop micro-application',
  'label.artifact': 'artifact',
  'label.sbom': 'SBOM',
  'label.release': 'release',
  'error.kind': '--kind must be web or desktop.',
  'error.devDelimiter': '`aw dev` requires a command after `--`, for example: aw dev -- pnpm dev.',
  'error.devEmpty': '`aw dev` command cannot be empty.',
  'error.artifactMapConflict': '--artifact-map cannot be combined with --input or --artifact-name.',
  'error.expectedConflict': 'Use only one of --expected-current-release-id and --expected-none.',
  'error.channel': '--channel must be dev, canary, or stable.',
  'error.requiredOption': 'Missing required option --{name}.',
  'error.uuid': '{label} must be a UUID.',
  'error.timeout': '--timeout-seconds must be an integer from 5 to 600.',
  'error.manifestMissing': 'Manifest is missing or is not valid JSON: {path}',
  'error.manifestValidation': 'Manifest validation failed.',
  'error.manifestValidationAt': 'Manifest validation failed at {path} ({code}).',
  'error.arguments': 'Invalid command options. Run `aw help` for usage.',
  'error.spawn': 'Unable to start development command: {command}',
  'error.signal': 'Development command terminated by signal {signal}.',
  'api.request': 'API request failed: {detail}',
  'api.http': 'API request failed with HTTP {status}{detail}',
  'api.envelope': 'API returned an invalid success envelope.',
  'api.baseAbsolute': 'API base URL must be an absolute HTTP(S) URL.',
  'api.baseSafe': 'API base URL must be an HTTP(S) origin or path without credentials, query, or fragment.',
  'api.path': 'API paths must be same-origin absolute paths.',
  'upload.failed': '{label} upload failed: {detail}',
  'upload.http': '{label} upload failed with HTTP {status}.',
  'auth.state': 'Login callback state did not match; the authorization response was rejected.',
  'auth.notFound': 'Not found',
  'auth.codeMissing': 'Login callback did not include an authorization code.',
  'auth.completed': 'Awesome Workflow login completed. You can close this window.',
  'auth.rejected': 'Authorization response rejected. Return to the terminal.',
  'auth.port': 'Unable to allocate a loopback callback port.',
  'auth.timeout': 'Timed out waiting for the login callback.',
  'auth.closed': 'Login callback listener closed.',
  'auth.invalidResponse': 'CLI authorization endpoint returned an invalid response.',
  'auth.invalidUrl': 'CLI authorization URL must use HTTP(S).',
  'auth.invalidSession': 'Authentication endpoint returned an invalid short-lived session.',
  'auth.sessionLifetime':
    'Authentication endpoint did not return a short-lived CLI session (maximum lifetime is 24 hours).',
  'auth.openBrowser':
    'Unable to open the system browser. Open the authorization URL manually using a trusted terminal.',
  'auth.workloadUnsupported':
    'Server does not support workload authentication. Required endpoint: /api/v1/auth/workload/exchange.',
  'auth.interactiveUnsupported':
    'Server does not support interactive CLI authentication. Required endpoints: /api/v1/auth/cli/authorize and /api/v1/auth/cli/token; the browser cookie flow is intentionally not reused.',
  'auth.tokenUnsupported':
    'Server does not support CLI token exchange. Required endpoint: /api/v1/auth/cli/token.',
  'credential.missing': 'No CLI session is stored. Run `aw login` first or pass --token-env NAME.',
  'credential.unreadable': 'The stored CLI session cannot be read. Run `aw login` again.',
  'credential.invalid': 'The stored CLI session is invalid. Run `aw login` again.',
  'credential.differentServer':
    'The stored CLI session belongs to a different API server. Run `aw login --api ...`.',
  'credential.expired': 'The stored CLI session has expired. Run `aw login` again.',
  'environment.invalidName': 'Environment variable names must contain only letters, digits, and underscores.',
  'environment.missing': 'Environment variable {name} is empty or missing.',
  'archive.empty': 'Package input directory does not contain any regular files.',
  'archive.tooManyFiles': 'ZIP64 is not supported; package contains too many files.',
  'archive.duplicatePath': 'Package contains duplicate cross-platform paths.',
  'archive.tooLarge': 'ZIP64 is not supported; package exceeds 4 GiB.',
  'archive.symbolicLink': 'Package input contains a symbolic link: {name}',
  'archive.nonRegular': 'Package input contains a non-regular file: {name}',
  'archive.invalidPath': 'Archive entry contains an absolute or invalid path.',
  'archive.pathEscape': 'Archive entry escapes its extraction root.',
  'archive.windowsUnsafe': 'Archive entry is unsafe on Windows.',
  'archive.windowsReserved': 'Archive entry uses a reserved Windows device name.',
  'package.manifestExists': 'Refusing to overwrite existing manifest: {path}',
  'package.artifactMapUnreadable': 'Artifact map is missing or is not valid JSON: {path}',
  'package.artifactMapShape': 'Artifact map must contain schemaVersion 1 and an artifacts array.',
  'package.artifactMapEmpty': 'Artifact map must contain at least one artifact.',
  'package.artifactMapEntry': 'Artifact map entry {index} must contain a valid name and input path.',
  'package.keyId': '--key-id must contain 1 to 160 characters.',
  'package.metadataUnreadable': 'Package metadata is missing or invalid. Run `aw package` first.',
  'package.metadataArtifactSet':
    'Package metadata does not contain the complete signed manifest artifact set.',
  'package.artifactBytesChanged':
    'Packaged artifact {name} bytes no longer match package metadata. Re-run `aw package`.',
  'package.sbomBytesChanged':
    'Packaged SBOM for {name} no longer matches package metadata. Re-run `aw package`.',
  'package.metadataDeclaration': 'Package metadata does not match the signed manifest artifact declaration.',
  'package.keyExactlyOne': 'Provide exactly one of --private-key PATH or --private-key-env NAME.',
  'package.keyNotFile': 'Publisher private key path is not a regular file.',
  'package.keyPermissions':
    'Publisher private key file must not be readable by group or other users (expected mode 0600).',
  'package.keyFormat': 'Publisher private key must be an Ed25519 PKCS#8 PEM or base64-encoded DER value.',
  'package.keyAlgorithm': 'Publisher private key must use Ed25519.',
  'package.artifactMapConflict': 'Artifact-map packaging cannot be combined with --input or --artifact-name.',
  'package.artifactMapDesktopOnly': 'Artifact-map packaging is supported only for desktop release manifests.',
  'package.artifactMapDuplicate': 'Artifact map contains duplicate name: {name}',
  'package.artifactMapUndeclared': 'Artifact map name is not declared by the manifest: {name}',
  'package.artifactMapMissing':
    'Artifact map must cover the complete manifest artifact set; missing: {names}',
  'package.inputRequired': 'Package input directory is required.',
  'package.multipleArtifacts':
    'Manifest declares multiple artifacts; use --artifact-map so one package contains the complete release artifact set.',
  'package.artifactNameInvalid': '--artifact-name is invalid.',
  'package.artifactNameMismatch':
    '--artifact-name must match the manifest artifact when one is already declared.',
  'package.desktopArtifactRequired': 'Desktop manifest must declare at least one artifact.',
  'package.federationManifestCount':
    'Federation package must contain exactly one {fileName} so integritySha256 can be bound.',
  'package.federationDigestBinding':
    'Federation manifestUrl must contain {placeholder} or the built manifest digest in its path.',
  'package.runtimeEntryMissing':
    'Desktop runtime entry for artifact {artifactName} is missing from package input: {entry}',
  'package.metadataShape': 'Package metadata has an unsupported shape.',
  'package.metadataDuplicateNames': 'Package metadata contains duplicate artifact names.',
  'package.primarySbomPath': 'Primary SBOM path must match the CycloneDX package path.',
  'package.metadataDuplicatePaths': 'Package metadata contains duplicate file paths.',
  'package.artifactMetadataShape': 'Package artifact metadata has an unsupported shape.',
  'package.primarySbomMissing': 'Package metadata is missing its primary SBOM.',
  'package.primarySbomDescriptorMissing': 'Package metadata is missing its primary SBOM descriptor.',
  'package.sbomMetadataShape': 'Package SBOM metadata has an unsupported shape.',
  'package.unsafeMetadataPath': 'Package metadata contains an unsafe file path.',
  'package.metadataPathEscape': 'Package metadata file path escapes its directory.',
  'package.outputInsideInput': 'Package output directory must be outside the package input directory.',
  'control.expectedRevision':
    'Promotion requires --expected-current-release-id, --expected-none, or --workspace-id to derive the current channel revision.',
  'control.catalogResponse': 'Catalog response is invalid.',
  'control.promotionResponse': 'Promotion response is invalid.',
  'control.releaseStatusResponse': 'Release status response is invalid.',
  'control.artifactStatusResponse': 'Release artifact status is invalid.',
  'control.reviewStatusResponse': 'Release review status is invalid.',
  'control.uploadIntent': 'Artifact upload intent is invalid.',
  'control.sbomIntentMissing':
    'Server did not provide an SBOM upload intent. Publishing stopped before finalize; the current release API cannot safely accept this package.',
  'control.targetIntent': '{label} upload intent is invalid.',
  'control.targetHeaders': '{label} upload headers are invalid.',
  'control.targetUrl': '{label} upload URL is invalid.',
  'control.targetProtocol': '{label} upload URL must use HTTP(S).',
  'control.targetExpired': '{label} upload intent is already expired.',
  'control.submitResponse': 'Submit response is invalid.',
  'control.submitArtifactResponse': 'Submit artifact response is invalid.',
  'control.createIdResponse': 'Create {label} response did not include an id.',
  'control.responseField': 'Response field {key} is missing.',
  'problem.validation_failed': 'Request validation failed',
  'problem.invalid_credentials': 'The email or password is incorrect',
  'problem.invalid_grant': 'The authorization grant is invalid or expired',
  'problem.not_authenticated': 'Sign in before continuing',
  'problem.forbidden': 'The current identity cannot perform this action',
  'problem.not_found': 'The requested resource was not found',
  'problem.invalid_state': 'The operation conflicts with the current resource state',
  'problem.channel_changed': 'The channel pointer changed; refresh and retry',
  'problem.permission_approval_required':
    'The device owner must approve the additional permissions before execution',
  'problem.internal_error': 'The server could not complete the request',
  'problem.withCode': '{message} [{code}]',
  'problem.unknown': 'The server rejected the request.',
};

const zhCN: Record<string, string> = {
  help: HELP_ZH,
  'locale.missing': '--locale 需要指定 en-US 或 zh-CN。',
  'locale.duplicate': '--locale 只能指定一次。',
  'locale.unsupported': '不支持语言 {locale}。支持的语言：en-US、zh-CN。',
  'command.unknown': '未知命令：{command}。运行 `aw help` 查看用法。',
  'success.authenticated': '已以 {email} 登录；会话将在 {expiresAt} 过期。',
  'success.manifestCreated': '已创建 {kind} Manifest：{path}。运行 `aw package` 前签名尚未配置。',
  'success.packaged': '已打包 {count} 个制品：{summary}。元数据：{path}',
  'success.artifactSummary': '{name}={fileName}（{size} 字节，sha256 {sha256}）',
  'manifest.desktopDescription': '桌面微应用',
  'label.artifact': '制品',
  'label.sbom': 'SBOM',
  'label.release': '发布版本',
  'error.kind': '--kind 必须为 web 或 desktop。',
  'error.devDelimiter': '`aw dev` 要求在 `--` 后提供命令，例如：aw dev -- pnpm dev。',
  'error.devEmpty': '`aw dev` 命令不能为空。',
  'error.artifactMapConflict': '--artifact-map 不能与 --input 或 --artifact-name 同时使用。',
  'error.expectedConflict': '--expected-current-release-id 与 --expected-none 只能使用一个。',
  'error.channel': '--channel 必须为 dev、canary 或 stable。',
  'error.requiredOption': '缺少必填参数 --{name}。',
  'error.uuid': '{label} 必须是 UUID。',
  'error.timeout': '--timeout-seconds 必须是 5 到 600 的整数。',
  'error.manifestMissing': 'Manifest 不存在或不是有效 JSON：{path}',
  'error.manifestValidation': 'Manifest 校验失败。',
  'error.manifestValidationAt': 'Manifest 在 {path} 处校验失败（{code}）。',
  'error.arguments': '命令参数无效。运行 `aw help` 查看用法。',
  'error.spawn': '无法启动开发命令：{command}',
  'error.signal': '开发命令被信号 {signal} 终止。',
  'api.request': 'API 请求失败：{detail}',
  'api.http': 'API 请求返回 HTTP {status}{detail}',
  'api.envelope': 'API 返回了无效的成功响应结构。',
  'api.baseAbsolute': 'API 基础地址必须是绝对 HTTP(S) URL。',
  'api.baseSafe': 'API 基础地址必须是不含凭据、查询或片段的 HTTP(S) origin 或路径。',
  'api.path': 'API 路径必须是同源绝对路径。',
  'upload.failed': '{label} 上传失败：{detail}',
  'upload.http': '{label} 上传返回 HTTP {status}。',
  'auth.state': '登录回调 state 不匹配，授权响应已被拒绝。',
  'auth.notFound': '页面不存在',
  'auth.codeMissing': '登录回调未包含授权码。',
  'auth.completed': 'Awesome Workflow 登录完成，可以关闭此窗口。',
  'auth.rejected': '授权响应已被拒绝，请返回终端。',
  'auth.port': '无法分配 loopback 回调端口。',
  'auth.timeout': '等待登录回调超时。',
  'auth.closed': '登录回调监听器已关闭。',
  'auth.invalidResponse': 'CLI 授权端点返回了无效响应。',
  'auth.invalidUrl': 'CLI 授权 URL 必须使用 HTTP(S)。',
  'auth.invalidSession': '认证端点返回了无效的短期会话。',
  'auth.sessionLifetime': '认证端点未返回短期 CLI 会话（最长 24 小时）。',
  'auth.openBrowser': '无法打开系统浏览器，请在受信任的终端中手动打开授权 URL。',
  'auth.workloadUnsupported': '服务端不支持工作负载认证。缺少端点：/api/v1/auth/workload/exchange。',
  'auth.interactiveUnsupported':
    '服务端不支持交互式 CLI 认证。缺少端点：/api/v1/auth/cli/authorize 和 /api/v1/auth/cli/token；CLI 不会复用浏览器 Cookie 流程。',
  'auth.tokenUnsupported': '服务端不支持 CLI 授权码交换。缺少端点：/api/v1/auth/cli/token。',
  'credential.missing': '未保存 CLI 会话。请先运行 `aw login`，或传入 --token-env NAME。',
  'credential.unreadable': '无法读取已保存的 CLI 会话，请重新运行 `aw login`。',
  'credential.invalid': '已保存的 CLI 会话无效，请重新运行 `aw login`。',
  'credential.differentServer': '已保存的 CLI 会话属于另一个 API 服务，请运行 `aw login --api ...`。',
  'credential.expired': '已保存的 CLI 会话已过期，请重新运行 `aw login`。',
  'environment.invalidName': '环境变量名只能包含字母、数字和下划线。',
  'environment.missing': '环境变量 {name} 为空或不存在。',
  'archive.empty': '打包输入目录不包含任何普通文件。',
  'archive.tooManyFiles': '不支持 ZIP64；软件包文件数量过多。',
  'archive.duplicatePath': '软件包包含跨平台重名路径。',
  'archive.tooLarge': '不支持 ZIP64；软件包超过 4 GiB。',
  'archive.symbolicLink': '打包输入包含符号链接：{name}',
  'archive.nonRegular': '打包输入包含非普通文件：{name}',
  'archive.invalidPath': '归档条目包含绝对路径或无效路径。',
  'archive.pathEscape': '归档条目逃逸了解压根目录。',
  'archive.windowsUnsafe': '归档条目在 Windows 上不安全。',
  'archive.windowsReserved': '归档条目使用了 Windows 保留设备名。',
  'package.manifestExists': '拒绝覆盖已有 Manifest：{path}',
  'package.artifactMapUnreadable': '制品映射不存在或不是有效 JSON：{path}',
  'package.artifactMapShape': '制品映射必须包含 schemaVersion 1 和 artifacts 数组。',
  'package.artifactMapEmpty': '制品映射必须至少包含一个制品。',
  'package.artifactMapEntry': '制品映射第 {index} 项必须包含有效名称和输入路径。',
  'package.keyId': '--key-id 长度必须为 1 到 160 个字符。',
  'package.metadataUnreadable': '软件包元数据不存在或无效，请先运行 `aw package`。',
  'package.metadataArtifactSet': '软件包元数据未包含已签名 Manifest 的完整制品集合。',
  'package.artifactBytesChanged': '已打包制品 {name} 的内容与软件包元数据不再匹配，请重新运行 `aw package`。',
  'package.sbomBytesChanged': '制品 {name} 的 SBOM 与软件包元数据不再匹配，请重新运行 `aw package`。',
  'package.metadataDeclaration': '软件包元数据与已签名 Manifest 的制品声明不匹配。',
  'package.keyExactlyOne': '--private-key PATH 与 --private-key-env NAME 必须且只能提供一个。',
  'package.keyNotFile': '发布者私钥路径不是普通文件。',
  'package.keyPermissions': '发布者私钥文件不能允许用户组或其他用户读取（预期权限 0600）。',
  'package.keyFormat': '发布者私钥必须是 Ed25519 PKCS#8 PEM 或 Base64 编码的 DER。',
  'package.keyAlgorithm': '发布者私钥必须使用 Ed25519。',
  'package.artifactMapConflict': '制品映射打包不能与 --input 或 --artifact-name 同时使用。',
  'package.artifactMapDesktopOnly': '制品映射打包仅支持桌面端发布 Manifest。',
  'package.artifactMapDuplicate': '制品映射包含重复名称：{name}',
  'package.artifactMapUndeclared': 'Manifest 未声明制品映射名称：{name}',
  'package.artifactMapMissing': '制品映射必须覆盖 Manifest 的完整制品集合；缺少：{names}',
  'package.inputRequired': '必须提供打包输入目录。',
  'package.multipleArtifacts':
    'Manifest 声明了多个制品；请使用 --artifact-map，让一个软件包包含完整发布制品集合。',
  'package.artifactNameInvalid': '--artifact-name 无效。',
  'package.artifactNameMismatch': '--artifact-name 必须匹配 Manifest 中已声明的制品。',
  'package.desktopArtifactRequired': '桌面端 Manifest 必须至少声明一个制品。',
  'package.federationManifestCount':
    'Federation 软件包必须恰好包含一个 {fileName}，才能绑定 integritySha256。',
  'package.federationDigestBinding':
    'Federation manifestUrl 的路径必须包含 {placeholder} 或构建出的 Manifest 摘要。',
  'package.runtimeEntryMissing': '制品 {artifactName} 的桌面运行入口不在打包输入中：{entry}',
  'package.metadataShape': '软件包元数据结构不受支持。',
  'package.metadataDuplicateNames': '软件包元数据包含重复制品名称。',
  'package.primarySbomPath': '主 SBOM 路径必须与 CycloneDX 软件包路径一致。',
  'package.metadataDuplicatePaths': '软件包元数据包含重复文件路径。',
  'package.artifactMetadataShape': '软件包制品元数据结构不受支持。',
  'package.primarySbomMissing': '软件包元数据缺少主 SBOM。',
  'package.primarySbomDescriptorMissing': '软件包元数据缺少主 SBOM 描述符。',
  'package.sbomMetadataShape': '软件包 SBOM 元数据结构不受支持。',
  'package.unsafeMetadataPath': '软件包元数据包含不安全的文件路径。',
  'package.metadataPathEscape': '软件包元数据文件路径逃逸了其目录。',
  'package.outputInsideInput': '软件包输出目录必须位于打包输入目录之外。',
  'control.expectedRevision':
    '晋级需要 --expected-current-release-id、--expected-none 或 --workspace-id，以确定当前 Channel 修订。',
  'control.catalogResponse': 'Catalog 响应无效。',
  'control.promotionResponse': '晋级响应无效。',
  'control.releaseStatusResponse': '发布状态响应无效。',
  'control.artifactStatusResponse': '发布制品状态无效。',
  'control.reviewStatusResponse': '发布审核状态无效。',
  'control.uploadIntent': '制品上传意图无效。',
  'control.sbomIntentMissing':
    '服务端未提供 SBOM 上传意图。发布已在 finalize 前停止；当前发布 API 无法安全接收此软件包。',
  'control.targetIntent': '{label}上传意图无效。',
  'control.targetHeaders': '{label}上传请求头无效。',
  'control.targetUrl': '{label}上传 URL 无效。',
  'control.targetProtocol': '{label}上传 URL 必须使用 HTTP(S)。',
  'control.targetExpired': '{label}上传意图已过期。',
  'control.submitResponse': '提交发布的响应无效。',
  'control.submitArtifactResponse': '提交发布返回的制品响应无效。',
  'control.createIdResponse': '创建{label}的响应未包含 id。',
  'control.responseField': '响应缺少字段 {key}。',
  'problem.validation_failed': '请求参数校验失败',
  'problem.invalid_credentials': '邮箱或密码错误',
  'problem.invalid_grant': '授权已失效或已过期',
  'problem.not_authenticated': '请先登录',
  'problem.forbidden': '当前身份没有执行此操作的权限',
  'problem.not_found': '请求的资源不存在',
  'problem.invalid_state': '操作与资源当前状态冲突',
  'problem.channel_changed': 'Channel 指针已变化，请刷新后重试',
  'problem.permission_approval_required': '执行前需要设备所有者批准新增权限',
  'problem.internal_error': '服务器无法完成该请求',
  'problem.withCode': '{message} [{code}]',
  'problem.unknown': '服务端拒绝了该请求。',
};

export const CLI_MESSAGES: Readonly<Record<SupportedLocale, Readonly<Record<string, string>>>> = {
  'en-US': enUS,
  'zh-CN': zhCN,
};
