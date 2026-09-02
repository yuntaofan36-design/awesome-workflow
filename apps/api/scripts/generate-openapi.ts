import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import {
  ApplicationSchema,
  ApprovePermissionGrantInputSchema,
  ArtifactSchema,
  AuthProviderSchema,
  AuthSessionResultSchema,
  CatalogEntrySchema,
  ClaimRunsInputSchema,
  ClaimRunsResultSchema,
  CliAuthorizationInputSchema,
  CliAuthorizationResultSchema,
  CliRefreshTokenInputSchema,
  CliRefreshTokenResultSchema,
  CliSessionResultSchema,
  CliTokenInputSchema,
  CreateApplicationInputSchema,
  CreateArtifactInputSchema,
  CreateManualRunInputSchema,
  CreateReleaseInputSchema,
  CreateScheduleInputSchema,
  CreateWorkspaceInputSchema,
  CurrentUserSchema,
  DeviceListResultSchema,
  DeviceSchema,
  FinalizeArtifactInputSchema,
  InstallationListResultSchema,
  InstallationSchema,
  InstallationSyncQuerySchema,
  InstallationSyncResultSchema,
  ListDevicesQuerySchema,
  ListInstallationsQuerySchema,
  ListPermissionGrantsQuerySchema,
  ListReleasesQuerySchema,
  ListReviewQueueQuerySchema,
  ListRunsQuerySchema,
  ListSchedulesQuerySchema,
  OidcAuthorizationInputSchema,
  OidcAuthorizationResultSchema,
  PauseScheduleInputSchema,
  PermissionGrantListResultSchema,
  PermissionGrantPreviewSchema,
  PermissionGrantSchema,
  ProblemDetailsSchema,
  PromoteReleaseInputV1Schema,
  RegisterDeviceInputSchema,
  RegisterDeviceResultSchema,
  ReportRunStatusInputSchema,
  RequestInstallationInputSchema,
  RevokePermissionGrantResultSchema,
  ReleaseChannelNameSchema,
  ReleaseStatusViewSchema,
  ReleaseValidationResultSchema,
  ReviewReleaseInputSchema,
  RunListResultSchema,
  RunCancellationListResultSchema,
  RunSchema,
  ScheduleListResultSchema,
  ScheduleSchema,
  ScheduleSyncQuerySchema,
  ScheduleSyncResultSchema,
  StartEmailChallengeInputSchema,
  StartEmailChallengeResultSchema,
  UpdateInstallationStatusInputSchema,
  UpdateScheduleInputSchema,
  UploadIntentSchema,
  VerifyEmailChallengeInputSchema,
  WorkloadTokenExchangeInputSchema,
  WorkspaceSchema,
} from '@awesome-workflow/contracts';

extendZodWithOpenApi(z);
const registry = new OpenAPIRegistry();

// The exact discriminated Manifest contract is published separately as JSON
// Schema. The OpenAPI component keeps the stable envelope fields without
// forcing zod-to-openapi to erase `z.never()` branches used by link manifests.
const signatureOpenApi = z.object({
  algorithm: z.literal('ed25519'),
  keyId: z.string(),
  value: z.string(),
});
const sbomOpenApi = z.object({
  format: z.enum(['cyclonedx-json', 'spdx-json']),
  fileName: z.string(),
  mediaType: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const manifestOpenApi = z
  .object({
    schemaVersion: z.literal(1),
    appId: z.string(),
    version: z.string(),
    kind: z.enum(['web', 'desktop']),
    artifacts: z.array(
      z.object({
        name: z.string(),
        fileName: z.string(),
        mediaType: z.string(),
        size: z.number().int().positive(),
        sha256: z.string(),
      }),
    ),
    integrity: z.object({ algorithm: z.literal('sha256'), digest: z.string() }),
    signature: signatureOpenApi,
  })
  .passthrough()
  .openapi({
    description:
      'Versioned discriminated manifest. See /manifest/awesome-workflow-manifest.schema.json for the exact runtime-specific JSON Schema.',
  });
const releaseOpenApi = z.object({
  id: z.string().uuid(),
  applicationId: z.string().uuid(),
  version: z.string(),
  manifest: manifestOpenApi,
  manifestSha256: z.string(),
  signature: signatureOpenApi,
  sbom: sbomOpenApi,
  validationEvidence: z.array(z.record(z.string(), z.any())),
  status: z.enum(['draft', 'uploading', 'validating', 'ready', 'approved', 'rejected']),
  createdBy: z.string().uuid(),
  createdAt: z.string().datetime(),
});
const releaseStatusOpenApi = z.object({
  release: releaseOpenApi,
  artifacts: z.array(ArtifactSchema),
  reviews: z.array(z.record(z.string(), z.any())),
});
const releaseListItemOpenApi = z.object({
  application: ApplicationSchema,
  release: releaseOpenApi,
  artifactCount: z.number().int().nonnegative(),
  reviewCount: z.number().int().nonnegative(),
});
const catalogEntryOpenApi = z.object({
  applicationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  summary: z.string(),
  kind: z.enum(['web', 'desktop']),
  releaseId: z.string().uuid(),
  version: z.string(),
  channel: ReleaseChannelNameSchema,
  manifest: manifestOpenApi,
  promotedAt: z.string().datetime(),
});
const createReleaseOpenApi = z.object({
  version: z.string(),
  manifest: manifestOpenApi,
  signature: signatureOpenApi,
  sbom: sbomOpenApi,
});
const auditEventOpenApi = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  actorId: z.string().uuid(),
  action: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});

const schemas = {
  Application: registry.register('Application', ApplicationSchema),
  Artifact: registry.register('Artifact', ArtifactSchema),
  AuthProvider: registry.register('AuthProvider', AuthProviderSchema),
  AuthSession: registry.register('AuthSession', AuthSessionResultSchema),
  CatalogEntry: registry.register('CatalogEntry', catalogEntryOpenApi),
  CurrentUser: registry.register('CurrentUser', CurrentUserSchema),
  Device: registry.register('Device', DeviceSchema),
  Installation: registry.register('Installation', InstallationSchema),
  PermissionGrant: registry.register('PermissionGrant', PermissionGrantSchema),
  PermissionGrantPreview: registry.register('PermissionGrantPreview', PermissionGrantPreviewSchema),
  ProblemDetails: registry.register('ProblemDetails', ProblemDetailsSchema),
  ReleaseStatus: registry.register('ReleaseStatus', releaseStatusOpenApi),
  ReleaseListItem: registry.register('ReleaseListItem', releaseListItemOpenApi),
  Run: registry.register('Run', RunSchema),
  Schedule: registry.register('Schedule', ScheduleSchema),
  UploadIntent: registry.register('UploadIntent', UploadIntentSchema),
  Workspace: registry.register('Workspace', WorkspaceSchema),
};

registry.registerComponent('securitySchemes', 'sessionCookie', {
  type: 'apiKey',
  in: 'cookie',
  name: 'aw_session',
});
registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
});
registry.registerComponent('securitySchemes', 'deviceAuth', {
  type: 'http',
  scheme: 'Device',
  description: 'One-time-issued per-device credential. Human sessions are rejected on Agent routes.',
});
registry.registerComponent('securitySchemes', 'workerCallback', {
  type: 'http',
  scheme: 'bearer',
});

const authenticated = [{ sessionCookie: [] }, { bearerAuth: [] }];
const deviceAuthenticated = [{ deviceAuth: [] }];
const errorResponses = {
  400: problem('Invalid request'),
  401: problem('Authentication required'),
  403: problem('Not authorized'),
  409: problem('State conflict'),
};
const uuid = z.string().uuid();

register(
  'get',
  '/api/v1/health',
  'health',
  undefined,
  success(z.object({ service: z.string(), status: z.literal('ok') })),
  [],
);
register(
  'get',
  '/api/v1/auth/providers',
  'listAuthProviders',
  undefined,
  success(z.array(schemas.AuthProvider)),
  [],
);
register(
  'post',
  '/api/v1/auth/email/challenges',
  'requestEmailChallenge',
  {
    body: jsonBody(StartEmailChallengeInputSchema),
  },
  success(StartEmailChallengeResultSchema),
  [],
);
register(
  'post',
  '/api/v1/auth/email/verify',
  'verifyEmailChallenge',
  {
    body: jsonBody(VerifyEmailChallengeInputSchema),
  },
  success(schemas.CurrentUser),
  [],
);
register(
  'get',
  '/api/v1/auth/oidc/start',
  'startOidc',
  { query: OidcAuthorizationInputSchema },
  success(OidcAuthorizationResultSchema),
  [],
);
register(
  'post',
  '/api/v1/auth/cli/authorize',
  'startCliAuthorization',
  {
    body: jsonBody(CliAuthorizationInputSchema),
  },
  success(CliAuthorizationResultSchema),
  [],
);
registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/cli/token',
  operationId: 'exchangeOrRefreshCliToken',
  tags: ['Authentication'],
  security: [],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: CliTokenInputSchema },
        'application/x-www-form-urlencoded': { schema: CliRefreshTokenInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Authorization-code exchange envelope or standard OAuth refresh response',
      content: {
        'application/json': {
          schema: z.union([z.object({ data: CliSessionResultSchema }), CliRefreshTokenResultSchema]),
        },
      },
    },
    ...errorResponses,
  },
});
register(
  'post',
  '/api/v1/auth/workload/exchange',
  'exchangeWorkloadToken',
  {
    body: jsonBody(WorkloadTokenExchangeInputSchema),
  },
  success(schemas.AuthSession),
  [],
);
register('get', '/api/v1/auth/session', 'getSession', undefined, success(schemas.CurrentUser));
register('post', '/api/v1/auth/logout', 'logout', undefined, { description: 'Session revoked' });

register('get', '/api/v1/workspaces', 'listWorkspaces', undefined, success(z.array(schemas.Workspace)));
register(
  'post',
  '/api/v1/workspaces',
  'createWorkspace',
  {
    body: jsonBody(CreateWorkspaceInputSchema),
  },
  success(schemas.Workspace),
);
register(
  'post',
  '/api/v1/devices',
  'registerDevice',
  {
    body: jsonBody(RegisterDeviceInputSchema),
  },
  success(RegisterDeviceResultSchema),
);
register(
  'get',
  '/api/v1/devices',
  'listDevices',
  {
    query: ListDevicesQuerySchema,
  },
  success(DeviceListResultSchema),
);
register(
  'post',
  '/api/v1/devices/{deviceId}/revoke',
  'revokeDevice',
  {
    params: z.object({ deviceId: uuid }),
  },
  success(schemas.Device),
);
register(
  'post',
  '/api/v1/installations',
  'requestInstallation',
  {
    body: jsonBody(RequestInstallationInputSchema),
  },
  success(schemas.Installation),
);
register(
  'get',
  '/api/v1/installations',
  'listInstallations',
  {
    query: ListInstallationsQuerySchema,
  },
  success(InstallationListResultSchema),
);
register(
  'get',
  '/api/v1/installations/{installationId}',
  'getInstallation',
  {
    params: z.object({ installationId: uuid }),
  },
  success(schemas.Installation),
);
register(
  'post',
  '/api/v1/devices/{deviceId}/installations/{installationId}/status',
  'updateInstallationStatus',
  {
    params: z.object({ deviceId: uuid, installationId: uuid }),
    body: jsonBody(UpdateInstallationStatusInputSchema),
  },
  success(schemas.Installation),
  deviceAuthenticated,
);
register(
  'get',
  '/api/v1/devices/{deviceId}/installations/sync',
  'syncDeviceInstallations',
  {
    params: z.object({ deviceId: uuid }),
    query: InstallationSyncQuerySchema,
  },
  success(InstallationSyncResultSchema),
  deviceAuthenticated,
);
register(
  'get',
  '/api/v1/devices/{deviceId}/releases/{releaseId}/permission-requirement',
  'getPermissionRequirement',
  {
    params: z.object({ deviceId: uuid, releaseId: uuid }),
  },
  success(schemas.PermissionGrantPreview),
);
register(
  'post',
  '/api/v1/devices/{deviceId}/permission-grants',
  'approvePermissionGrant',
  {
    params: z.object({ deviceId: uuid }),
    body: jsonBody(ApprovePermissionGrantInputSchema),
  },
  success(schemas.PermissionGrant),
);
register(
  'get',
  '/api/v1/permission-grants',
  'listPermissionGrants',
  {
    query: ListPermissionGrantsQuerySchema,
  },
  success(PermissionGrantListResultSchema),
);
register(
  'post',
  '/api/v1/permission-grants/{grantId}/revoke',
  'revokePermissionGrant',
  {
    params: z.object({ grantId: uuid }),
  },
  success(RevokePermissionGrantResultSchema),
);
register(
  'post',
  '/api/v1/schedules',
  'createSchedule',
  {
    body: jsonBody(CreateScheduleInputSchema),
  },
  success(schemas.Schedule),
);
register(
  'get',
  '/api/v1/schedules',
  'listSchedules',
  {
    query: ListSchedulesQuerySchema,
  },
  success(ScheduleListResultSchema),
);
register(
  'get',
  '/api/v1/schedules/{scheduleId}',
  'getSchedule',
  {
    params: z.object({ scheduleId: uuid }),
  },
  success(schemas.Schedule),
);
register(
  'patch',
  '/api/v1/schedules/{scheduleId}',
  'updateSchedule',
  {
    params: z.object({ scheduleId: uuid }),
    body: jsonBody(UpdateScheduleInputSchema),
  },
  success(schemas.Schedule),
);
register(
  'post',
  '/api/v1/schedules/{scheduleId}/pause',
  'pauseSchedule',
  {
    params: z.object({ scheduleId: uuid }),
    body: jsonBody(PauseScheduleInputSchema),
  },
  success(schemas.Schedule),
);
register(
  'get',
  '/api/v1/devices/{deviceId}/schedules/sync',
  'syncDeviceSchedules',
  {
    params: z.object({ deviceId: uuid }),
    query: ScheduleSyncQuerySchema,
  },
  success(ScheduleSyncResultSchema),
  deviceAuthenticated,
);
register(
  'post',
  '/api/v1/runs',
  'createManualRun',
  {
    body: jsonBody(CreateManualRunInputSchema),
  },
  success(schemas.Run),
);
register(
  'get',
  '/api/v1/runs',
  'listRuns',
  {
    query: ListRunsQuerySchema,
  },
  success(RunListResultSchema),
);
register(
  'get',
  '/api/v1/runs/{runId}',
  'getRun',
  {
    params: z.object({ runId: uuid }),
  },
  success(schemas.Run),
);
register(
  'post',
  '/api/v1/runs/{runId}/cancel',
  'cancelRun',
  {
    params: z.object({ runId: uuid }),
  },
  success(schemas.Run),
);
register(
  'post',
  '/api/v1/devices/{deviceId}/runs/claim',
  'claimDeviceRuns',
  {
    params: z.object({ deviceId: uuid }),
    body: jsonBody(ClaimRunsInputSchema),
  },
  success(ClaimRunsResultSchema),
  deviceAuthenticated,
);
register(
  'get',
  '/api/v1/devices/{deviceId}/runs/control',
  'getDeviceRunControl',
  {
    params: z.object({ deviceId: uuid }),
  },
  success(RunCancellationListResultSchema),
  deviceAuthenticated,
);
register(
  'post',
  '/api/v1/devices/{deviceId}/runs/{runId}/report',
  'reportDeviceRun',
  {
    params: z.object({ deviceId: uuid, runId: uuid }),
    body: jsonBody(ReportRunStatusInputSchema),
  },
  success(schemas.Run),
  deviceAuthenticated,
);
register(
  'get',
  '/api/v1/workspaces/{workspaceId}/audit-events',
  'listAuditEvents',
  {
    params: z.object({ workspaceId: uuid }),
  },
  success(z.array(auditEventOpenApi)),
);
register(
  'get',
  '/api/v1/workspaces/{workspaceId}/applications',
  'listApplications',
  {
    params: z.object({ workspaceId: uuid }),
  },
  success(z.array(schemas.Application)),
);
register(
  'post',
  '/api/v1/workspaces/{workspaceId}/applications',
  'createApplication',
  {
    params: z.object({ workspaceId: uuid }),
    body: jsonBody(CreateApplicationInputSchema),
  },
  success(schemas.Application),
);
register(
  'get',
  '/api/v1/workspaces/{workspaceId}/releases',
  'listReleases',
  {
    params: z.object({ workspaceId: uuid }),
    query: ListReleasesQuerySchema,
  },
  success(z.array(schemas.ReleaseListItem)),
);
register(
  'post',
  '/api/v1/applications/{applicationId}/releases',
  'createRelease',
  {
    params: z.object({ applicationId: uuid }),
    body: jsonBody(createReleaseOpenApi),
  },
  success(z.unknown()),
);
register(
  'post',
  '/api/v1/releases/{releaseId}/artifacts',
  'createArtifactUpload',
  {
    params: z.object({ releaseId: uuid }),
    body: jsonBody(CreateArtifactInputSchema),
  },
  success(schemas.UploadIntent),
);
register(
  'post',
  '/api/v1/artifacts/{artifactId}/finalize',
  'finalizeArtifactUpload',
  {
    params: z.object({ artifactId: uuid }),
    body: jsonBody(FinalizeArtifactInputSchema),
  },
  success(schemas.Artifact),
);
register(
  'post',
  '/api/v1/releases/{releaseId}/submit',
  'submitRelease',
  {
    params: z.object({ releaseId: uuid }),
  },
  success(schemas.ReleaseStatus),
);
register(
  'get',
  '/api/v1/releases/{releaseId}/status',
  'getReleaseStatus',
  {
    params: z.object({ releaseId: uuid }),
  },
  success(schemas.ReleaseStatus),
);
register(
  'post',
  '/api/v1/releases/{releaseId}/reviews',
  'reviewRelease',
  {
    params: z.object({ releaseId: uuid }),
    body: jsonBody(ReviewReleaseInputSchema),
  },
  success(schemas.ReleaseStatus),
);
register(
  'get',
  '/api/v1/reviews',
  'listPendingReviews',
  {
    query: ListReviewQueueQuerySchema,
  },
  success(z.array(schemas.ReleaseListItem)),
);
register(
  'post',
  '/api/v1/applications/{applicationId}/channels/{channel}/promote',
  'promoteRelease',
  {
    params: z.object({ applicationId: uuid, channel: ReleaseChannelNameSchema }),
    body: jsonBody(PromoteReleaseInputV1Schema),
  },
  success(schemas.CatalogEntry),
);
register(
  'get',
  '/api/v1/catalog',
  'listCatalog',
  {
    query: z.object({
      workspaceId: uuid,
      channel: ReleaseChannelNameSchema.default('stable'),
      kind: z.enum(['web', 'desktop']).optional(),
    }),
  },
  success(z.array(schemas.CatalogEntry)),
);

registry.registerPath({
  method: 'post',
  path: '/api/v1/internal/releases/{releaseId}/validation-result',
  operationId: 'applyReleaseValidation',
  tags: ['Internal'],
  security: [{ workerCallback: [] }],
  request: {
    params: z.object({ releaseId: uuid }),
    body: jsonBody(ReleaseValidationResultSchema),
  },
  responses: { 200: success(schemas.ReleaseStatus), ...errorResponses },
});

const generator = new OpenApiGeneratorV31(registry.definitions);
const document = generator.generateDocument({
  openapi: '3.1.0',
  info: {
    title: 'Awesome Workflow Control Plane API',
    version: '1.0.0',
    description: 'Immutable web and desktop micro-application publication and runtime control plane.',
  },
  servers: [{ url: '/' }],
});
await writeFile(
  fileURLToPath(new URL('../src/openapi.generated.json', import.meta.url)),
  `${JSON.stringify(document, null, 2)}\n`,
  'utf8',
);
const manifestSchema = JSON.parse(
  await readFile(
    fileURLToPath(
      new URL(
        '../../../packages/manifest-schema/dist/awesome-workflow-manifest.schema.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as unknown;
await writeFile(
  fileURLToPath(new URL('../src/manifest.generated.json', import.meta.url)),
  `${JSON.stringify(manifestSchema, null, 2)}\n`,
  'utf8',
);

function register(
  method: 'get' | 'patch' | 'post',
  path: string,
  operationId: string,
  request: Parameters<OpenAPIRegistry['registerPath']>[0]['request'] | undefined,
  response: ReturnType<typeof success>,
  security = authenticated,
): void {
  registry.registerPath({
    method,
    path,
    operationId,
    tags: [
      path.includes('/auth/') ? 'Authentication' : path.includes('/catalog') ? 'Catalog' : 'Control Plane',
    ],
    security,
    ...(request ? { request } : {}),
    responses: { 200: response, 201: response, ...errorResponses },
  });
}

function jsonBody(schema: z.ZodTypeAny) {
  return { required: true, content: { 'application/json': { schema } } };
}

function success(schema: z.ZodTypeAny) {
  return {
    description: 'Successful response',
    content: { 'application/json': { schema: z.object({ data: schema }) } },
  };
}

function problem(description: string) {
  return {
    description,
    content: { 'application/problem+json': { schema: schemas.ProblemDetails } },
  };
}
