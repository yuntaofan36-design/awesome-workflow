import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.string().url().optional());
const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);
const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(32).optional(),
);

const DEVELOPMENT_SESSION_SECRET = 'development-only-secret-change-before-production';
const DEVELOPMENT_OTP_PEPPER = 'development-only-otp-pepper-change-before-production';
const DEVELOPMENT_WORKER_TOKEN = 'development-worker-token-change-before-production';

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().default('127.0.0.1'),
    API_PORT: z.coerce.number().int().positive().max(65_535).default(4100),
    API_PUBLIC_URL: z.string().url().default('http://localhost:4100'),
    WEB_PUBLIC_URL: z.string().url().default('http://localhost:4300'),
    API_ORIGINS: z
      .string()
      .default('http://localhost:4300,http://localhost:4302,tauri://localhost,http://tauri.localhost'),
    REPOSITORY_MODE: z.enum(['memory', 'postgres']).default('memory'),
    DATABASE_URL: optionalUrl,
    REDIS_URL: optionalUrl,
    SESSION_SECRET: z.string().min(32).default(DEVELOPMENT_SESSION_SECRET),
    OTP_PEPPER: z.string().min(32).default(DEVELOPMENT_OTP_PEPPER),
    AUTH_MODE: z.enum(['local_otp', 'oidc', 'hybrid']).default('local_otp'),
    AUTH_DEV_EXPOSE_OTP: booleanString,
    EMAIL_DELIVERY: z.enum(['noop', 'smtp', 'webhook']).default('noop'),
    SMTP_HOST: optionalString,
    SMTP_PORT: z.coerce.number().int().positive().max(65_535).default(587),
    SMTP_SECURE: booleanString,
    SMTP_REQUIRE_TLS: booleanString,
    SMTP_USER: optionalString,
    SMTP_PASSWORD: optionalString,
    SMTP_FROM: optionalString,
    EMAIL_WEBHOOK_URL: optionalUrl,
    EMAIL_WEBHOOK_TOKEN: optionalSecret,
    BOOTSTRAP_ADMIN_EMAILS: z.string().default(''),
    WORKER_CALLBACK_TOKEN: z.string().min(32).default(DEVELOPMENT_WORKER_TOKEN),
    VALIDATION_QUEUE_MODE: z.enum(['memory', 'redis']).default('memory'),
    OBJECT_STORAGE_MODE: z.enum(['memory', 's3']).default('memory'),
    ARTIFACT_UPLOAD_BASE_URL: z.string().url().default('http://localhost:9000/awesome-workflow'),
    S3_ENDPOINT: optionalUrl,
    S3_PUBLIC_ENDPOINT: optionalUrl,
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(3).max(63).default('awesome-workflow-artifacts'),
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    S3_FORCE_PATH_STYLE: booleanString,
    OIDC_ISSUER: optionalUrl,
    OIDC_CLIENT_ID: z.string().optional(),
    OIDC_CLIENT_SECRET: z.string().optional(),
    OIDC_REDIRECT_URI: optionalUrl,
    OIDC_POST_LOGIN_REDIRECT: optionalUrl,
    // Connector credentials belong to Logto. The platform stores only which
    // brokered provider buttons should be exposed to clients.
    OIDC_ENABLED_PROVIDERS: z.string().default('email'),
    WORKLOAD_OIDC_POLICIES: z.string().default('[]'),
  })
  .superRefine((value, context) => {
    if (value.REPOSITORY_MODE === 'postgres' && !value.DATABASE_URL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL is required for the PostgreSQL repository',
      });
    }
    if (value.EMAIL_DELIVERY === 'webhook' && (!value.EMAIL_WEBHOOK_URL || !value.EMAIL_WEBHOOK_TOKEN)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_WEBHOOK_URL'],
        message: 'Webhook URL and token are required for webhook email delivery',
      });
    }
    if (value.EMAIL_DELIVERY === 'smtp' && (!value.SMTP_HOST || !value.SMTP_FROM)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_HOST'],
        message: 'SMTP host and sender are required for SMTP email delivery',
      });
    }
    if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASSWORD)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_USER'],
        message: 'SMTP username and password must be configured together',
      });
    }
    if (
      ['oidc', 'hybrid'].includes(value.AUTH_MODE) &&
      (!value.OIDC_ISSUER || !value.OIDC_CLIENT_ID || !value.OIDC_CLIENT_SECRET || !value.OIDC_REDIRECT_URI)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OIDC_ISSUER'],
        message: 'OIDC issuer, client id, client secret, and redirect URI are required in OIDC mode',
      });
    }
    if (value.VALIDATION_QUEUE_MODE === 'redis' && !value.REDIS_URL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'Redis URL is required for the validation queue',
      });
    }
    if (
      value.OBJECT_STORAGE_MODE === 's3' &&
      (!value.S3_ENDPOINT ||
        !value.S3_PUBLIC_ENDPOINT ||
        !value.S3_ACCESS_KEY_ID ||
        !value.S3_SECRET_ACCESS_KEY)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_ENDPOINT'],
        message: 'S3 internal/public endpoints and credentials are required for S3 object storage',
      });
    }
    const providers = value.OIDC_ENABLED_PROVIDERS.split(',')
      .map((provider) => provider.trim())
      .filter(Boolean);
    if (providers.some((provider) => !['email', 'google', 'feishu', 'wechat'].includes(provider))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OIDC_ENABLED_PROVIDERS'],
        message: 'Only email, google, feishu, and wechat provider descriptors are supported',
      });
    }
    try {
      z.array(
        z.object({
          issuer: z.string().url(),
          audience: z.string().min(1),
          jwksUri: z.string().url(),
          subject: z.string().min(1),
          principalEmail: z.string().email(),
          displayName: z.string().min(1).max(120),
        }),
      ).parse(JSON.parse(value.WORKLOAD_OIDC_POLICIES));
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WORKLOAD_OIDC_POLICIES'],
        message: 'Workload OIDC policies must be a valid JSON policy array',
      });
    }
    if (value.NODE_ENV === 'production') {
      if (value.REPOSITORY_MODE !== 'postgres') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['REPOSITORY_MODE'],
          message: 'Production requires the PostgreSQL repository',
        });
      }
      if (!value.REDIS_URL) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['REDIS_URL'],
          message: 'Production requires Redis for validation jobs',
        });
      }
      if (value.VALIDATION_QUEUE_MODE !== 'redis') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['VALIDATION_QUEUE_MODE'],
          message: 'Production requires the Redis validation queue',
        });
      }
      if (value.OBJECT_STORAGE_MODE !== 's3') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['OBJECT_STORAGE_MODE'],
          message: 'Production requires S3-compatible object storage',
        });
      }
      if (value.AUTH_MODE !== 'hybrid') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTH_MODE'],
          message: 'Production authentication must use hybrid BFF email OTP and OIDC social login',
        });
      }
      if (value.EMAIL_DELIVERY !== 'smtp') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EMAIL_DELIVERY'],
          message: 'Production hybrid authentication requires SMTP email delivery',
        });
      }
      if (value.EMAIL_DELIVERY === 'smtp' && !value.SMTP_SECURE && !value.SMTP_REQUIRE_TLS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SMTP_REQUIRE_TLS'],
          message: 'Production SMTP must use implicit TLS or require STARTTLS',
        });
      }
      if (
        value.EMAIL_DELIVERY === 'webhook' &&
        value.EMAIL_WEBHOOK_URL &&
        new URL(value.EMAIL_WEBHOOK_URL).protocol !== 'https:'
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EMAIL_WEBHOOK_URL'],
          message: 'Production email webhook must use HTTPS',
        });
      }
      for (const [key, actual, development] of [
        ['SESSION_SECRET', value.SESSION_SECRET, DEVELOPMENT_SESSION_SECRET],
        ['OTP_PEPPER', value.OTP_PEPPER, DEVELOPMENT_OTP_PEPPER],
        ['WORKER_CALLBACK_TOKEN', value.WORKER_CALLBACK_TOKEN, DEVELOPMENT_WORKER_TOKEN],
      ] as const) {
        if (actual === development || actual.startsWith('change-me')) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} must be replaced before production`,
          });
        }
      }
      if (value.AUTH_DEV_EXPOSE_OTP) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTH_DEV_EXPOSE_OTP'],
          message: 'OTP exposure is forbidden in production',
        });
      }
      if (value.OIDC_ISSUER && new URL(value.OIDC_ISSUER).protocol !== 'https:') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['OIDC_ISSUER'],
          message: 'Production OIDC issuer must use HTTPS',
        });
      }
      if (new URL(value.API_PUBLIC_URL).protocol !== 'https:') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['API_PUBLIC_URL'],
          message: 'Production API public URL must use HTTPS',
        });
      }
      if (value.OIDC_REDIRECT_URI && new URL(value.OIDC_REDIRECT_URI).protocol !== 'https:') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['OIDC_REDIRECT_URI'],
          message: 'Production OIDC redirect URI must use HTTPS',
        });
      }
      if (value.OIDC_POST_LOGIN_REDIRECT && new URL(value.OIDC_POST_LOGIN_REDIRECT).protocol !== 'https:') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['OIDC_POST_LOGIN_REDIRECT'],
          message: 'Production OIDC post-login redirect must use HTTPS',
        });
      }
      if (new URL(value.WEB_PUBLIC_URL).protocol !== 'https:') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEB_PUBLIC_URL'],
          message: 'Production Web Shell URL must use HTTPS',
        });
      }
    }
  });

export type PlatformConfig = ReturnType<typeof loadPlatformConfig>;

export function loadPlatformConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.parse(environment);
  const workloadOidcPolicies = z
    .array(
      z.object({
        issuer: z.string().url(),
        audience: z.string().min(1),
        jwksUri: z.string().url(),
        subject: z.string().min(1),
        principalEmail: z.string().email(),
        displayName: z.string().min(1).max(120),
      }),
    )
    .parse(JSON.parse(parsed.WORKLOAD_OIDC_POLICIES));
  return {
    ...parsed,
    origins: parsed.API_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    bootstrapAdminEmails: new Set(
      parsed.BOOTSTRAP_ADMIN_EMAILS.split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
    oidcEnabledProviders: new Set(
      parsed.OIDC_ENABLED_PROVIDERS.split(',')
        .map((provider) => provider.trim())
        .filter(Boolean),
    ),
    workloadOidcPolicies,
  };
}

export const CONFIG = Symbol('AW_CONFIG');
