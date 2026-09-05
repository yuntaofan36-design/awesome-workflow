import { z } from 'zod';

import {
  ApplicationSlugSchema,
  DesktopCapabilitySchema,
  DesktopPlatformSchema,
  PublisherSignatureSchema,
  SemanticVersionSchema,
  Sha256Schema,
} from '@awesome-workflow/manifest-schema';

import { DesktopManifestSchema } from './catalog.js';

const UuidSchema = z.string().uuid();
const TimestampSchema = z.string().datetime();
const RevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const UnixEpochMillisecondsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .describe('Unix epoch milliseconds');
const PositiveRevisionSchema = RevisionSchema.refine(
  (revision) => revision > 0,
  'Expected a positive revision',
);
const ErrorCodeSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9_]*$/);
const RunResultSchema = z.record(z.string(), z.unknown());

/**
 * Server-authoritative, bounded authorization for work that may start while a
 * device is offline. The signature covers the complete claims object; the
 * local Agent still issues a separate opaque task lease for Runner/RPC use.
 */
export const AuthorizationLeaseTaskSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('schedule'), id: UuidSchema }),
  z.object({ kind: z.literal('run'), id: UuidSchema }),
]);
export type AuthorizationLeaseTask = z.infer<typeof AuthorizationLeaseTaskSchema>;

export const AuthorizationLeaseClaimsSchema = z
  .object({
    schemaVersion: z.literal(1),
    leaseId: UuidSchema,
    revision: PositiveRevisionSchema,
    deviceId: UuidSchema,
    applicationId: UuidSchema,
    releaseId: UuidSchema,
    appId: ApplicationSlugSchema,
    version: SemanticVersionSchema,
    task: AuthorizationLeaseTaskSchema,
    capabilityHash: Sha256Schema,
    intentHash: Sha256Schema,
    issuedAt: UnixEpochMillisecondsSchema,
    expiresAt: UnixEpochMillisecondsSchema,
  })
  .superRefine((claims, context) => {
    if (claims.expiresAt <= claims.issuedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Authorization lease expiry must follow issuance',
      });
    }
  });
export type AuthorizationLeaseClaims = z.infer<typeof AuthorizationLeaseClaimsSchema>;

export const AuthorizationLeaseSignatureSchema = z.object({
  algorithm: z.literal('ed25519'),
  keyId: z.string().min(1).max(160),
  value: z.string().min(40).max(256),
});
export type AuthorizationLeaseSignature = z.infer<typeof AuthorizationLeaseSignatureSchema>;

export const AuthorizationLeaseSchema = z.object({
  claims: AuthorizationLeaseClaimsSchema,
  signature: AuthorizationLeaseSignatureSchema,
});
export type AuthorizationLease = z.infer<typeof AuthorizationLeaseSchema>;

export function canonicalizeAuthorizationLeaseClaims(input: AuthorizationLeaseClaims): string {
  return authorizationLeaseCanonicalJson(AuthorizationLeaseClaimsSchema.parse(input));
}

export function authorizationLeaseSignaturePayload(input: AuthorizationLeaseClaims): Uint8Array {
  return new TextEncoder().encode(
    `awesome-workflow:authorization-lease:v1\n${canonicalizeAuthorizationLeaseClaims(input)}`,
  );
}

/**
 * Domain-separated canonical bytes hashed by the control plane and recomputed
 * by the Agent from the complete schedule/run record before offline execution.
 */
export function authorizationLeaseIntentPayload(input: unknown): Uint8Array {
  return new TextEncoder().encode(
    `awesome-workflow:authorization-intent:v1\n${authorizationLeaseCanonicalJson(input)}`,
  );
}

function authorizationLeaseCanonicalJson(value: unknown): string {
  if (value === undefined) throw new TypeError('Undefined is not valid canonical JSON');
  if (Array.isArray(value)) return `[${value.map(authorizationLeaseCanonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${authorizationLeaseCanonicalJson(nested)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Value is not valid canonical JSON');
  return encoded;
}

export const DesktopExecutionInputSchema = z.object({
  args: z.array(z.string().max(8_192)).max(256).default([]),
});
export type DesktopExecutionInput = z.infer<typeof DesktopExecutionInputSchema>;

export const DeviceStatusSchema = z.enum(['active', 'revoked']);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

export const DeviceSchema = z.object({
  id: UuidSchema,
  workspaceId: UuidSchema,
  ownerId: UuidSchema,
  name: z.string().min(1).max(120),
  os: DesktopPlatformSchema.shape.os,
  arch: DesktopPlatformSchema.shape.arch,
  agentVersion: SemanticVersionSchema,
  publicKeyThumbprint: z
    .string()
    .min(16)
    .max(256)
    .regex(/^[A-Za-z0-9:_-]+$/),
  status: DeviceStatusSchema,
  lastSeenAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type Device = z.infer<typeof DeviceSchema>;

export const RegisterDeviceInputSchema = DeviceSchema.pick({
  workspaceId: true,
  name: true,
  os: true,
  arch: true,
  agentVersion: true,
  publicKeyThumbprint: true,
});
export type RegisterDeviceInput = z.infer<typeof RegisterDeviceInputSchema>;

/** One-time opaque credential returned only by device registration. */
export const DeviceCredentialSchema = z
  .string()
  .length(47)
  .regex(/^awd_[A-Za-z0-9_-]{43}$/);
export type DeviceCredential = z.infer<typeof DeviceCredentialSchema>;

export const RegisterDeviceResultSchema = z.object({
  device: DeviceSchema,
  credential: DeviceCredentialSchema,
});
export type RegisterDeviceResult = z.infer<typeof RegisterDeviceResultSchema>;

export const ListDevicesQuerySchema = z.object({
  workspaceId: UuidSchema,
  status: DeviceStatusSchema.optional(),
});
export type ListDevicesQuery = z.infer<typeof ListDevicesQuerySchema>;
export const DeviceListResultSchema = z.array(DeviceSchema);
export type DeviceListResult = z.infer<typeof DeviceListResultSchema>;
export const RevokeDeviceResultSchema = DeviceSchema;
export type RevokeDeviceResult = Device;

export const InstallationStatusSchema = z.enum([
  'requested',
  'downloading',
  'installed',
  'failed',
  'removed',
]);
export type InstallationStatus = z.infer<typeof InstallationStatusSchema>;

export const InstallationSchema = z.object({
  id: UuidSchema,
  workspaceId: UuidSchema,
  deviceId: UuidSchema,
  applicationId: UuidSchema,
  releaseId: UuidSchema,
  status: InstallationStatusSchema,
  errorCode: ErrorCodeSchema.nullable(),
  installedAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
  createdAt: TimestampSchema,
});
export type Installation = z.infer<typeof InstallationSchema>;

export const RequestInstallationInputSchema = InstallationSchema.pick({
  workspaceId: true,
  deviceId: true,
  applicationId: true,
  releaseId: true,
});
export type RequestInstallationInput = z.infer<typeof RequestInstallationInputSchema>;

export const ListInstallationsQuerySchema = z.object({
  workspaceId: UuidSchema,
  deviceId: UuidSchema.optional(),
  status: InstallationStatusSchema.optional(),
});
export type ListInstallationsQuery = z.infer<typeof ListInstallationsQuerySchema>;
export const InstallationListResultSchema = z.array(InstallationSchema);
export type InstallationListResult = z.infer<typeof InstallationListResultSchema>;
export const InstallationStatusResultSchema = InstallationSchema;
export type InstallationStatusResult = Installation;

export const InstallationSyncQuerySchema = z.object({
  revision: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type InstallationSyncQuery = z.infer<typeof InstallationSyncQuerySchema>;

export const InstallationSyncArtifactSchema = z.object({
  name: z.string().min(1).max(120),
  fileName: z.string().min(1).max(240),
  mediaType: z.string().min(1).max(120),
  size: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 * 1024 * 1024),
  sha256: Sha256Schema,
  downloadUrl: z.string().url(),
  downloadExpiresAt: TimestampSchema,
  attestation: PublisherSignatureSchema.optional(),
});
export type InstallationSyncArtifact = z.infer<typeof InstallationSyncArtifactSchema>;

export const InstallationSyncItemSchema = z.object({
  installationId: UuidSchema,
  status: z.enum(['requested', 'downloading', 'installed']),
  appId: ApplicationSlugSchema,
  version: SemanticVersionSchema,
  manifest: DesktopManifestSchema,
  artifact: InstallationSyncArtifactSchema,
});
export type InstallationSyncItem = z.infer<typeof InstallationSyncItemSchema>;

export const InstallationSyncSnapshotSchema = z
  .object({
    revision: RevisionSchema,
    installations: z.array(InstallationSyncItemSchema),
  })
  .superRefine((snapshot, context) => {
    const ids = new Set<string>();
    for (const [index, installation] of snapshot.installations.entries()) {
      if (ids.has(installation.installationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['installations', index, 'installationId'],
          message: 'An installation can appear only once per snapshot',
        });
      }
      ids.add(installation.installationId);
    }
  });
export type InstallationSyncSnapshot = z.infer<typeof InstallationSyncSnapshotSchema>;

export const InstallationSyncResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot'), snapshot: InstallationSyncSnapshotSchema }),
  z.object({ kind: z.literal('unchanged'), revision: RevisionSchema }),
]);
export type InstallationSyncResult = z.infer<typeof InstallationSyncResultSchema>;

export const ReportableInstallationStatusSchema = z.enum(['downloading', 'installed', 'failed', 'removed']);
export type ReportableInstallationStatus = z.infer<typeof ReportableInstallationStatusSchema>;
export const UpdateInstallationStatusInputSchema = z.object({
  status: ReportableInstallationStatusSchema,
  errorCode: ErrorCodeSchema.optional(),
});
export type UpdateInstallationStatusInput = z.infer<typeof UpdateInstallationStatusInputSchema>;

export const PermissionGrantStatusSchema = z.enum(['active', 'revoked', 'expired']);
export type PermissionGrantStatus = z.infer<typeof PermissionGrantStatusSchema>;

const PermissionGrantScopeSchema = z.object({
  workspaceId: UuidSchema,
  deviceId: UuidSchema,
  applicationId: UuidSchema,
  releaseId: UuidSchema,
});

export const PermissionGrantSchema = PermissionGrantScopeSchema.extend({
  id: UuidSchema,
  capabilities: z.array(DesktopCapabilitySchema),
  capabilityHash: Sha256Schema,
  status: PermissionGrantStatusSchema,
  grantedBy: UuidSchema,
  revokedAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;

export const PermissionGrantPreviewQuerySchema = z.object({ releaseId: UuidSchema });
export type PermissionGrantPreviewQuery = z.infer<typeof PermissionGrantPreviewQuerySchema>;
export const PermissionGrantPreviewSchema = PermissionGrantScopeSchema.extend({
  capabilities: z.array(DesktopCapabilitySchema),
  capabilityHash: Sha256Schema,
  approvalRequired: z.boolean(),
});
export type PermissionGrantPreview = z.infer<typeof PermissionGrantPreviewSchema>;

export const ApprovePermissionGrantInputSchema = z
  .object({
    releaseId: UuidSchema,
    expectedCapabilityHash: Sha256Schema,
    expiresAt: TimestampSchema.optional(),
  })
  .strict();
export type ApprovePermissionGrantInput = z.infer<typeof ApprovePermissionGrantInputSchema>;

export const ListPermissionGrantsQuerySchema = z.object({
  workspaceId: UuidSchema,
  deviceId: UuidSchema.optional(),
  applicationId: UuidSchema.optional(),
  status: PermissionGrantStatusSchema.optional(),
});
export type ListPermissionGrantsQuery = z.infer<typeof ListPermissionGrantsQuerySchema>;
export const PermissionGrantListResultSchema = z.array(PermissionGrantSchema);
export type PermissionGrantListResult = z.infer<typeof PermissionGrantListResultSchema>;
export const RevokePermissionGrantResultSchema = PermissionGrantSchema;
export type RevokePermissionGrantResult = PermissionGrant;

export const ScheduleStatusSchema = z.enum(['active', 'paused', 'disabled']);
export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

export const ScheduleSchema = z.object({
  id: UuidSchema,
  workspaceId: UuidSchema,
  applicationId: UuidSchema,
  releaseId: UuidSchema,
  targetDeviceId: UuidSchema.nullable(),
  name: z.string().min(1).max(120),
  cronExpression: z.string().min(1).max(160),
  timezone: z.string().min(1).max(120),
  nextRunAtMs: UnixEpochMillisecondsSchema,
  input: DesktopExecutionInputSchema,
  status: ScheduleStatusSchema,
  revision: PositiveRevisionSchema,
  createdBy: UuidSchema,
  updatedAt: TimestampSchema,
  createdAt: TimestampSchema,
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const CreateScheduleInputSchema = ScheduleSchema.pick({
  workspaceId: true,
  applicationId: true,
  releaseId: true,
  name: true,
  cronExpression: true,
  timezone: true,
  nextRunAtMs: true,
  input: true,
}).extend({ targetDeviceId: UuidSchema });
export type CreateScheduleInput = z.infer<typeof CreateScheduleInputSchema>;

const MutableScheduleFieldsSchema = ScheduleSchema.pick({
  releaseId: true,
  targetDeviceId: true,
  name: true,
  cronExpression: true,
  timezone: true,
  nextRunAtMs: true,
  input: true,
});

export const UpdateScheduleInputSchema = MutableScheduleFieldsSchema.partial()
  .extend({ expectedRevision: PositiveRevisionSchema })
  .refine(
    (input) =>
      Object.entries(input).some(([key, value]) => key !== 'expectedRevision' && value !== undefined),
    'At least one schedule field must be updated',
  );
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleInputSchema>;

export const PauseScheduleInputSchema = z.object({
  expectedRevision: PositiveRevisionSchema,
  paused: z.boolean().default(true),
});
export type PauseScheduleInput = z.infer<typeof PauseScheduleInputSchema>;

export const ListSchedulesQuerySchema = z.object({
  workspaceId: UuidSchema,
  targetDeviceId: UuidSchema.optional(),
  status: ScheduleStatusSchema.optional(),
});
export type ListSchedulesQuery = z.infer<typeof ListSchedulesQuerySchema>;
export const ScheduleListResultSchema = z.array(ScheduleSchema);
export type ScheduleListResult = z.infer<typeof ScheduleListResultSchema>;

/** Exact JSON shape consumed by the Rust Agent's ScheduleRecord. */
export const ScheduleRecordIntentSchema = z.object({
  scheduleId: UuidSchema,
  revision: PositiveRevisionSchema,
  applicationId: UuidSchema,
  releaseId: UuidSchema,
  appId: ApplicationSlugSchema,
  version: SemanticVersionSchema.optional(),
  cronExpression: ScheduleSchema.shape.cronExpression,
  timezone: ScheduleSchema.shape.timezone,
  nextRunAtMs: UnixEpochMillisecondsSchema,
  args: DesktopExecutionInputSchema.shape.args,
  enabled: z.boolean(),
});
export type ScheduleRecordIntent = z.infer<typeof ScheduleRecordIntentSchema>;

export const ScheduleRecordSchema = ScheduleRecordIntentSchema.extend({
  authorizationLease: AuthorizationLeaseSchema,
}).superRefine((record, context) => {
  const claims = record.authorizationLease.claims;
  if (
    claims.task.kind !== 'schedule' ||
    claims.task.id !== record.scheduleId ||
    claims.revision !== record.revision ||
    claims.applicationId !== record.applicationId ||
    claims.releaseId !== record.releaseId ||
    claims.appId !== record.appId ||
    (record.version !== undefined && claims.version !== record.version)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['authorizationLease', 'claims'],
      message: 'Authorization lease scope must match its schedule record',
    });
  }
});
export type ScheduleRecord = z.infer<typeof ScheduleRecordSchema>;

/** Exact JSON shape consumed by the Rust Agent's ScheduleSnapshot. */
export const ScheduleSnapshotSchema = z.object({
  revision: RevisionSchema,
  schedules: z.array(ScheduleRecordSchema),
});
export type ScheduleSnapshot = z.infer<typeof ScheduleSnapshotSchema>;

export const ScheduleDeltaSchema = z
  .object({
    fromRevision: RevisionSchema,
    toRevision: RevisionSchema,
    upserts: z.array(ScheduleRecordSchema),
    removedScheduleIds: z.array(UuidSchema),
  })
  .superRefine((delta, context) => {
    if (delta.toRevision < delta.fromRevision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toRevision'],
        message: 'toRevision cannot precede fromRevision',
      });
    }

    const upsertedIds = new Set<string>();
    for (const [index, schedule] of delta.upserts.entries()) {
      if (upsertedIds.has(schedule.scheduleId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['upserts', index, 'scheduleId'],
          message: 'A schedule can be upserted only once per delta',
        });
      }
      upsertedIds.add(schedule.scheduleId);
    }

    const removedIds = new Set<string>();
    for (const [index, scheduleId] of delta.removedScheduleIds.entries()) {
      if (removedIds.has(scheduleId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['removedScheduleIds', index],
          message: 'A schedule can be removed only once per delta',
        });
      }
      if (upsertedIds.has(scheduleId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['removedScheduleIds', index],
          message: 'A schedule cannot be both upserted and removed in one delta',
        });
      }
      removedIds.add(scheduleId);
    }
  });
export type ScheduleDelta = z.infer<typeof ScheduleDeltaSchema>;

export const ScheduleSyncQuerySchema = z.object({
  revision: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type ScheduleSyncQuery = z.infer<typeof ScheduleSyncQuerySchema>;
export const ScheduleSyncResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot'), snapshot: ScheduleSnapshotSchema }),
  z.object({ kind: z.literal('delta'), delta: ScheduleDeltaSchema }),
]);
export type ScheduleSyncResult = z.infer<typeof ScheduleSyncResultSchema>;

export function applyScheduleDelta(snapshot: ScheduleSnapshot, delta: ScheduleDelta): ScheduleSnapshot {
  const current = ScheduleSnapshotSchema.parse(snapshot);
  const change = ScheduleDeltaSchema.parse(delta);
  if (current.revision !== change.fromRevision) {
    throw new Error(
      `Schedule delta starts at revision ${change.fromRevision}, but the current snapshot is revision ${current.revision}`,
    );
  }

  const schedules = new Map(current.schedules.map((schedule) => [schedule.scheduleId, schedule]));
  for (const scheduleId of change.removedScheduleIds) {
    schedules.delete(scheduleId);
  }
  for (const schedule of change.upserts) {
    schedules.set(schedule.scheduleId, schedule);
  }

  return ScheduleSnapshotSchema.parse({ revision: change.toRevision, schedules: [...schedules.values()] });
}

export const RunStatusSchema = z.enum([
  'queued',
  'dispatched',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'needs_user_approval',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;
export const RunTriggerSchema = z.enum(['manual', 'schedule', 'api']);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

export const RunSchema = z.object({
  id: UuidSchema,
  workspaceId: UuidSchema,
  scheduleId: UuidSchema.nullable(),
  installationId: UuidSchema.nullable(),
  deviceId: UuidSchema,
  applicationId: UuidSchema,
  releaseId: UuidSchema,
  trigger: RunTriggerSchema,
  status: RunStatusSchema,
  attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  input: DesktopExecutionInputSchema,
  result: RunResultSchema.nullable(),
  requiresElevation: z.boolean(),
  errorCode: ErrorCodeSchema.nullable(),
  cancelRequestedAt: TimestampSchema.nullable(),
  triggeredBy: UuidSchema.nullable(),
  queuedAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
});
export type Run = z.infer<typeof RunSchema>;

export const CreateManualRunInputSchema = RunSchema.pick({
  workspaceId: true,
  deviceId: true,
  applicationId: true,
  releaseId: true,
  input: true,
});
export type CreateManualRunInput = z.infer<typeof CreateManualRunInputSchema>;

export const ListRunsQuerySchema = z.object({
  workspaceId: UuidSchema,
  deviceId: UuidSchema.optional(),
  scheduleId: UuidSchema.optional(),
  trigger: RunTriggerSchema.optional(),
  status: RunStatusSchema.optional(),
});
export type ListRunsQuery = z.infer<typeof ListRunsQuerySchema>;
export const RunListResultSchema = z.array(RunSchema);
export type RunListResult = z.infer<typeof RunListResultSchema>;
export const RunStatusResultSchema = RunSchema;
export type RunStatusResult = Run;
export const CancelRunResultSchema = RunSchema;
export type CancelRunResult = Run;

export const ClaimRunsInputSchema = z.object({
  limit: z.number().int().min(1).max(32).default(1),
});
export type ClaimRunsInput = z.infer<typeof ClaimRunsInputSchema>;

export const RunClaimIntentSchema = z.object({
  runId: UuidSchema,
  attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  appId: ApplicationSlugSchema,
  version: SemanticVersionSchema,
  args: DesktopExecutionInputSchema.shape.args,
  requiresElevation: z.boolean(),
});
export type RunClaimIntent = z.infer<typeof RunClaimIntentSchema>;
export const RunClaimSchema = RunClaimIntentSchema.extend({
  authorizationLease: AuthorizationLeaseSchema,
}).superRefine((claim, context) => {
  const claims = claim.authorizationLease.claims;
  if (
    claims.task.kind !== 'run' ||
    claims.task.id !== claim.runId ||
    claims.revision !== claim.attempt ||
    claims.appId !== claim.appId ||
    claims.version !== claim.version
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['authorizationLease', 'claims'],
      message: 'Authorization lease scope must match its run claim',
    });
  }
});
export type RunClaim = z.infer<typeof RunClaimSchema>;
export const ClaimRunsResultSchema = z.array(RunClaimSchema);
export type ClaimRunsResult = z.infer<typeof ClaimRunsResultSchema>;

export const RunCancellationSchema = z.object({
  runId: UuidSchema,
  attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  cancelRequestedAt: TimestampSchema,
});
export type RunCancellation = z.infer<typeof RunCancellationSchema>;
export const RunCancellationListResultSchema = z.array(RunCancellationSchema);
export type RunCancellationListResult = z.infer<typeof RunCancellationListResultSchema>;

export const ReportableRunStatusSchema = z.enum([
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'needs_user_approval',
]);
export type ReportableRunStatus = z.infer<typeof ReportableRunStatusSchema>;

export const ReportRunStatusInputSchema = z.object({
  attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: ReportableRunStatusSchema,
  result: RunResultSchema.optional(),
  errorCode: ErrorCodeSchema.optional(),
});
export type ReportRunStatusInput = z.infer<typeof ReportRunStatusInputSchema>;

export const InstalledAppletSchema = z.object({
  appId: z.string(),
  version: z.string(),
  installPath: z.string(),
  installedAt: z.string(),
  manifest: DesktopManifestSchema,
});
export type InstalledApplet = z.infer<typeof InstalledAppletSchema>;

export const DesktopTaskSchema = z.object({
  taskId: z.string().uuid(),
  appId: z.string(),
  version: z.string(),
  status: z.enum(['starting', 'running', 'succeeded', 'failed', 'stopped']),
  startedAt: z.string(),
  pid: z.number().int().positive().optional(),
  logPath: z.string(),
});
export type DesktopTask = z.infer<typeof DesktopTaskSchema>;

export const HostSnapshotSchema = z.object({
  hostVersion: z.string(),
  platform: z.string(),
  developerMode: z.boolean(),
  installed: z.array(InstalledAppletSchema),
  tasks: z.array(DesktopTaskSchema),
});
export type HostSnapshot = z.infer<typeof HostSnapshotSchema>;

export const AppletEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('log'),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
  }),
  z.object({ type: z.literal('progress'), value: z.number().min(0).max(1), label: z.string().optional() }),
  z.object({ type: z.literal('result'), data: z.unknown() }),
]);
export type AppletEvent = z.infer<typeof AppletEventSchema>;
