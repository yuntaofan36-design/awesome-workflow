import type { FastifyReply } from 'fastify';

import type { SupportedLocale } from '@awesome-workflow/contracts';
import { DEFAULT_LOCALE, normalizeLocale } from '@awesome-workflow/i18n';

type ProblemMessage = { title?: string; detail: string };

export function negotiateLocale(header: string | readonly string[] | undefined): SupportedLocale {
  const source = typeof header === 'string' ? header : header?.join(',');
  if (!source) return DEFAULT_LOCALE;

  const preferences = source
    .split(',')
    .map((part, index) => {
      const [tag = '', ...parameters] = part.trim().split(';');
      const qualityParameter = parameters.find((parameter) =>
        parameter.trim().toLowerCase().startsWith('q='),
      );
      const parsedQuality = qualityParameter
        ? Number.parseFloat(qualityParameter.slice(qualityParameter.indexOf('=') + 1))
        : 1;
      return {
        index,
        locale: tag.trim() === '*' ? DEFAULT_LOCALE : normalizeLocale(tag),
        quality:
          Number.isFinite(parsedQuality) && parsedQuality >= 0 && parsedQuality <= 1 ? parsedQuality : 0,
      };
    })
    .filter(
      (preference): preference is { index: number; locale: SupportedLocale; quality: number } =>
        preference.locale !== null && preference.quality > 0,
    )
    .sort((left, right) => right.quality - left.quality || left.index - right.index);

  return preferences[0]?.locale ?? DEFAULT_LOCALE;
}

export function setLanguageHeaders(reply: FastifyReply, locale: SupportedLocale): void {
  reply.header('content-language', locale);
  const current = reply.getHeader('vary');
  const values = String(current ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.some((value) => value.toLowerCase() === 'accept-language')) values.push('Accept-Language');
  reply.header('vary', values.join(', '));
}

export function problemTitle(locale: SupportedLocale, status: number): string {
  const key =
    status === 400
      ? 'badRequest'
      : status === 401
        ? 'unauthorized'
        : status === 403
          ? 'forbidden'
          : status === 404
            ? 'notFound'
            : status === 409
              ? 'conflict'
              : status === 429
                ? 'rateLimited'
                : status >= 500
                  ? 'internal'
                  : 'failed';
  return TITLES[locale][key];
}

export function problemDetail(
  locale: SupportedLocale,
  code: string,
  fallback: string | undefined,
  status: number,
): string | undefined {
  return PROBLEMS[locale][code]?.detail ?? fallback ?? DEFAULT_DETAILS[locale][statusClass(status)];
}

export function loginEmailContent(
  locale: SupportedLocale,
  code: string,
  expiresInMinutes: number,
): { subject: string; text: string } {
  if (locale === 'zh-CN') {
    return {
      subject: 'Awesome Workflow 登录验证码',
      text: [
        `您的登录验证码是 ${code}。`,
        '',
        `验证码将在 ${expiresInMinutes} 分钟后过期。`,
        '如果这不是您的操作，请忽略此邮件。',
      ].join('\n'),
    };
  }
  return {
    subject: 'Your Awesome Workflow sign-in code',
    text: [
      `Your sign-in code is ${code}.`,
      '',
      `It expires in ${expiresInMinutes} minutes.`,
      'If you did not request this code, ignore this email.',
    ].join('\n'),
  };
}

const TITLES: Record<
  SupportedLocale,
  Record<
    | 'badRequest'
    | 'conflict'
    | 'failed'
    | 'forbidden'
    | 'internal'
    | 'notFound'
    | 'rateLimited'
    | 'unauthorized',
    string
  >
> = {
  'en-US': {
    badRequest: 'Bad Request',
    conflict: 'Conflict',
    failed: 'Request Failed',
    forbidden: 'Forbidden',
    internal: 'Internal Server Error',
    notFound: 'Not Found',
    rateLimited: 'Too Many Requests',
    unauthorized: 'Unauthorized',
  },
  'zh-CN': {
    badRequest: '请求无效',
    conflict: '状态冲突',
    failed: '请求失败',
    forbidden: '禁止访问',
    internal: '服务器内部错误',
    notFound: '资源不存在',
    rateLimited: '请求过于频繁',
    unauthorized: '未认证',
  },
};

const ENGLISH_PROBLEM_DETAILS: Record<string, ProblemMessage> = {
  validation_failed: { detail: 'Request validation failed' },
  internal_error: { detail: 'The server could not complete the request' },
};

const CHINESE_PROBLEM_DETAILS: Record<string, ProblemMessage> = {
  validation_failed: { detail: '请求参数校验失败' },
  http_error: { detail: 'HTTP 请求失败' },
  internal_error: { detail: '服务器无法完成该请求' },
  not_found: { detail: '请求的资源不存在' },
  forbidden: { detail: '当前身份没有执行此操作的权限' },
  invalid_state: { detail: '该操作与资源当前状态冲突' },
  not_authenticated: { detail: '请先登录后再继续' },
  device_not_authenticated: { detail: '桌面设备认证失败' },
  worker_not_authenticated: { detail: 'Worker 认证失败' },
  invalid_credentials: { detail: '邮箱或密码错误' },
  password_auth_disabled: { detail: '管理员账号密码登录未启用' },
  local_auth_disabled: { detail: '邮箱验证码登录未启用' },
  oidc_disabled: { detail: 'OIDC 登录未启用' },
  social_provider_disabled: { detail: '所选第三方登录方式未启用' },
  social_provider_required: { detail: '请选择第三方登录方式' },
  invalid_return_to: { detail: '登录返回地址无效' },
  invalid_grant: { detail: '授权已失效或已过期' },
  auth_rate_limited: { detail: '登录尝试过于频繁，请稍后重试' },
  challenge_rate_limited: { detail: '请稍后再请求新的验证码' },
  challenge_attempts_exhausted: { detail: '验证码尝试次数已用尽' },
  invalid_workload_token: { detail: '工作负载身份令牌无效' },
  workload_not_trusted: { detail: '该工作负载身份不受信任' },
  application_slug_exists: { detail: '当前工作区中已存在相同应用标识' },
  workspace_slug_exists: { detail: '已存在相同工作区标识' },
  release_version_exists: { detail: '该应用版本已存在，版本创建后不可覆盖' },
  artifact_name_exists: { detail: '该制品名称已登记' },
  artifact_not_declared: { detail: 'Manifest 未声明该制品' },
  artifact_signer_mismatch: { detail: '制品签名者与 Release 不一致' },
  manifest_identity_mismatch: { detail: 'Manifest 的应用或版本身份不匹配' },
  manifest_integrity_mismatch: { detail: 'Manifest 的制品完整性摘要不匹配' },
  manifest_signature_mismatch: { detail: 'Manifest 签名不匹配' },
  release_id_mismatch: { detail: 'Release 标识不匹配' },
  channel_changed: { detail: 'Channel 指针在操作期间发生变化，请刷新后重试' },
  validation_queue_unavailable: { detail: '校验队列暂时不可用' },
  object_not_uploaded: { detail: '对象尚未上传完成' },
  object_size_mismatch: { detail: '对象大小与声明不一致' },
  object_checksum_mismatch: { detail: '对象校验和与声明不一致' },
  object_content_type_mismatch: { detail: '对象内容类型与声明不一致' },
  object_metadata_mismatch: { detail: '对象元数据与声明不一致' },
  authorization_lease_signing_unavailable: { detail: '离线授权租约签名服务不可用' },
  device_credential_exists: { detail: '该设备已存在凭据' },
  device_key_scope_changed: { detail: '设备密钥所属范围已变化' },
  installation_artifact_unavailable: { detail: '安装制品不可用' },
  installation_not_actionable: { detail: '安装当前不能执行该操作' },
  installation_release_invalid: { detail: '安装所引用的 Release 无效' },
  installation_revision_ahead: { detail: '设备安装修订版本超前于服务端' },
  permission_approval_required: { detail: '执行前需要设备所有者批准新增权限' },
  permission_requirement_changed: { detail: '应用所需权限已变化，请重新审批' },
  run_attempt_changed: { detail: '运行尝试序号已变化' },
  run_report_mismatch: { detail: '运行结果报告与服务端状态不一致' },
  schedule_changed: { detail: '计划在操作期间发生变化，请同步后重试' },
  schedule_revision_ahead: { detail: '设备计划修订版本超前于服务端' },
};

const PROBLEMS: Record<SupportedLocale, Record<string, ProblemMessage>> = {
  'en-US': ENGLISH_PROBLEM_DETAILS,
  'zh-CN': CHINESE_PROBLEM_DETAILS,
};

const DEFAULT_DETAILS: Record<SupportedLocale, Record<string, string>> = {
  'en-US': {
    '4xx': 'The request could not be completed',
    '5xx': 'The server could not complete the request',
  },
  'zh-CN': {
    '4xx': '无法完成该请求',
    '5xx': '服务器无法完成该请求',
  },
};

function statusClass(status: number): string {
  return status >= 500 ? '5xx' : '4xx';
}
