import {
  bigint,
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { SbomDescriptor, ScheduleRecord, ValidationEvidence } from '@awesome-workflow/contracts';
import type {
  DesktopCapability,
  PublisherSignature,
  ReleaseManifest,
} from '@awesome-workflow/manifest-schema';

export const workspaceRoleEnum = pgEnum('workspace_role', ['owner', 'admin', 'developer', 'member']);
export const platformRoleEnum = pgEnum('platform_role', ['platform_admin', 'official_reviewer']);
export const applicationKindEnum = pgEnum('application_kind', ['web', 'desktop']);
export const releaseStatusEnum = pgEnum('release_status', [
  'draft',
  'uploading',
  'validating',
  'ready',
  'approved',
  'rejected',
]);
export const artifactStatusEnum = pgEnum('artifact_status', [
  'pending_upload',
  'uploaded',
  'validated',
  'rejected',
]);
export const releaseChannelEnum = pgEnum('release_channel', ['dev', 'canary', 'stable']);
export const reviewDecisionEnum = pgEnum('review_decision', ['approve', 'reject']);
export const deviceStatusEnum = pgEnum('device_status', ['active', 'revoked']);
export const installationStatusEnum = pgEnum('installation_status', [
  'requested',
  'downloading',
  'installed',
  'failed',
  'removed',
]);
export const permissionGrantStatusEnum = pgEnum('permission_grant_status', ['active', 'revoked', 'expired']);
export const scheduleStatusEnum = pgEnum('schedule_status', ['active', 'paused', 'disabled']);
export const runStatusEnum = pgEnum('run_status', [
  'queued',
  'dispatched',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'needs_user_approval',
]);
export const runTriggerEnum = pgEnum('run_trigger', ['manual', 'schedule', 'api']);
export const scheduleChangeOperationEnum = pgEnum('schedule_change_operation', ['upsert', 'remove']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    primaryEmail: text('primary_email').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('users_primary_email_idx').on(table.primaryEmail)],
);

export const userPlatformRoles = pgTable(
  'user_platform_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: platformRoleEnum('role').notNull(),
    grantedBy: uuid('granted_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.role] })],
);

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('auth_identities_issuer_subject_uq').on(table.issuer, table.subject)],
);

export const emailChallenges = pgTable(
  'email_challenges',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: bigint('attempts', { mode: 'number' }).notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('email_challenges_email_created_idx').on(table.email, table.createdAt)],
);

export const authTransactions = pgTable(
  'auth_transactions',
  {
    id: uuid('id').primaryKey(),
    stateHash: text('state_hash').notNull(),
    codeVerifier: text('code_verifier').notNull(),
    nonce: text('nonce').notNull(),
    provider: text('provider'),
    returnTo: text('return_to'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('auth_transactions_state_hash_uq').on(table.stateHash)],
);

export const cliAuthorizations = pgTable(
  'cli_authorizations',
  {
    id: uuid('id').primaryKey(),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    state: text('state').notNull(),
    offlineAccess: boolean('offline_access').notNull().default(false),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('cli_authorizations_code_hash_uq').on(table.codeHash)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    familyId: uuid('family_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('refresh_tokens_token_hash_uq').on(table.tokenHash),
    index('refresh_tokens_family_idx').on(table.familyId),
    index('refresh_tokens_user_idx').on(table.userId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    refreshFamilyId: uuid('refresh_family_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_uq').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
    index('sessions_refresh_family_idx').on(table.refreshFamilyId),
  ],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('workspaces_slug_uq').on(table.slug)],
);

export const workspaceMemberships = pgTable(
  'workspace_memberships',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRoleEnum('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index('workspace_memberships_user_idx').on(table.userId),
  ],
);

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    os: text('os').notNull(),
    arch: text('arch').notNull(),
    agentVersion: text('agent_version').notNull(),
    publicKeyThumbprint: text('public_key_thumbprint').notNull(),
    credentialHash: text('credential_hash').notNull(),
    installationRevision: bigint('installation_revision', { mode: 'number' }).notNull().default(0),
    status: deviceStatusEnum('status').notNull().default('active'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('devices_owner_key_uq').on(table.ownerId, table.publicKeyThumbprint),
    uniqueIndex('devices_credential_hash_uq').on(table.credentialHash),
    index('devices_workspace_idx').on(table.workspaceId),
  ],
);

export const applications = pgTable(
  'applications',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    summary: text('summary').notNull(),
    kind: applicationKindEnum('kind').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('applications_workspace_slug_uq').on(table.workspaceId, table.slug)],
);

export const releases = pgTable(
  'releases',
  {
    id: uuid('id').primaryKey(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    manifest: jsonb('manifest').$type<ReleaseManifest>().notNull(),
    manifestSha256: text('manifest_sha256').notNull(),
    signature: jsonb('signature').$type<PublisherSignature>().notNull(),
    sbom: jsonb('sbom').$type<SbomDescriptor>().notNull(),
    validationEvidence: jsonb('validation_evidence').$type<ValidationEvidence[]>().notNull().default([]),
    status: releaseStatusEnum('status').notNull().default('draft'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('releases_application_version_uq').on(table.applicationId, table.version)],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey(),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    signature: jsonb('signature').$type<PublisherSignature>().notNull(),
    sbom: jsonb('sbom').$type<SbomDescriptor>().notNull(),
    storageKey: text('storage_key').notNull(),
    sbomStorageKey: text('sbom_storage_key').notNull(),
    status: artifactStatusEnum('status').notNull().default('pending_upload'),
    validationEvidence: jsonb('validation_evidence').$type<ValidationEvidence[]>().notNull().default([]),
    etag: text('etag'),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('artifacts_release_filename_uq').on(table.releaseId, table.fileName)],
);

export const installations = pgTable(
  'installations',
  {
    id: uuid('id').primaryKey(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id),
    status: installationStatusEnum('status').notNull().default('requested'),
    errorCode: text('error_code'),
    installedAt: timestamp('installed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('installations_device_application_release_uq').on(
      table.deviceId,
      table.applicationId,
      table.releaseId,
    ),
    index('installations_device_status_idx').on(table.deviceId, table.status),
  ],
);

export const permissionGrants = pgTable(
  'permission_grants',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    capabilities: jsonb('capabilities').$type<DesktopCapability[]>().notNull(),
    capabilityHash: text('capability_hash').notNull(),
    status: permissionGrantStatusEnum('status').notNull().default('active'),
    grantedBy: uuid('granted_by')
      .notNull()
      .references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('permission_grants_scope_hash_uq').on(table.deviceId, table.releaseId, table.capabilityHash),
    index('permission_grants_workspace_status_idx').on(table.workspaceId, table.status),
  ],
);

export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id),
    targetDeviceId: uuid('target_device_id').references(() => devices.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    cronExpression: text('cron_expression').notNull(),
    timezone: text('timezone').notNull(),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    nextRunAtMs: bigint('next_run_at', { mode: 'number' }).notNull().default(0),
    args: jsonb('args').$type<string[]>().notNull().default([]),
    status: scheduleStatusEnum('status').notNull().default('active'),
    revision: bigint('revision', { mode: 'number' }).notNull().default(1),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('schedules_workspace_status_idx').on(table.workspaceId, table.status),
    index('schedules_target_device_idx').on(table.targetDeviceId),
  ],
);

export const scheduleWorkspaceRevisions = pgTable('schedule_workspace_revisions', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const scheduleChanges = pgTable(
  'schedule_changes',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    targetDeviceId: uuid('target_device_id').references(() => devices.id, { onDelete: 'cascade' }),
    operation: scheduleChangeOperationEnum('operation').notNull(),
    record: jsonb('record').$type<ScheduleRecord>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('schedule_changes_workspace_revision_idx').on(table.workspaceId, table.revision),
    index('schedule_changes_device_revision_idx').on(table.targetDeviceId, table.revision),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    scheduleId: uuid('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
    installationId: uuid('installation_id').references(() => installations.id, { onDelete: 'set null' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id),
    trigger: runTriggerEnum('trigger').notNull(),
    status: runStatusEnum('status').notNull().default('queued'),
    attempt: bigint('attempt', { mode: 'number' }).notNull().default(1),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb('result').$type<Record<string, unknown>>(),
    requiresElevation: boolean('requires_elevation').notNull().default(false),
    errorCode: text('error_code'),
    triggeredBy: uuid('triggered_by').references(() => users.id),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('runs_workspace_queued_idx').on(table.workspaceId, table.queuedAt),
    index('runs_device_status_idx').on(table.deviceId, table.status),
  ],
);

export const releaseReviews = pgTable(
  'release_reviews',
  {
    id: uuid('id').primaryKey(),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references(() => users.id),
    decision: reviewDecisionEnum('decision').notNull(),
    comment: text('comment').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('release_reviews_release_idx').on(table.releaseId)],
);

export const channels = pgTable(
  'channels',
  {
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    name: releaseChannelEnum('name').notNull(),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id),
    promotedBy: uuid('promoted_by')
      .notNull()
      .references(() => users.id),
    promotedAt: timestamp('promoted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.applicationId, table.name] })],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id),
    actorId: uuid('actor_id').references(() => users.id),
    actorDeviceId: uuid('actor_device_id').references(() => devices.id),
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_events_workspace_created_idx').on(table.workspaceId, table.createdAt)],
);
