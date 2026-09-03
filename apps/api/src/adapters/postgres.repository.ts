import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { OnModuleDestroy } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import {
  computeDesktopCapabilityHash,
  DesktopReleaseManifestSchema,
  type DesktopCapability,
} from '@awesome-workflow/manifest-schema';
import type {
  Application,
  Artifact,
  CatalogEntry,
  ClaimRunsInput,
  CreateManualRunInput,
  CreateScheduleInput,
  CurrentUser,
  Device,
  Installation,
  InstallationSyncQuery,
  InstallationStatus,
  ListDevicesQuery,
  ListInstallationsQuery,
  ListPermissionGrantsQuery,
  ListReleasesQuery,
  ListRunsQuery,
  ListSchedulesQuery,
  PauseScheduleInput,
  PlatformRole,
  PermissionGrant,
  RegisterDeviceInput,
  Release,
  ReleaseChannelName,
  ReleaseListItem,
  ReleaseReview,
  ReleaseStatusView,
  ReportRunStatusInput,
  RequestInstallationInput,
  Run,
  RunCancellation,
  Schedule,
  ScheduleRecordIntent,
  ScheduleSyncQuery,
  UpdateScheduleInput,
  Workspace,
  WorkspaceRole,
} from '@awesome-workflow/contracts';

import { conflict, DomainError, invalidState, notFound } from '../core/errors.js';
import type {
  ApplicationInput,
  ArtifactInput,
  AuditEventRecord,
  CliAuthorizationRecord,
  EmailChallengeRecord,
  IdentityInput,
  InstallationSyncIndex,
  OidcTransactionRecord,
  ApprovePermissionGrantRecordInput,
  AuthorizedRunClaimRecord,
  PermissionGrantRequirementInput,
  PlatformRepository,
  RefreshSessionInput,
  ReleaseInput,
  RotateRefreshSessionInput,
  RotateRefreshSessionResult,
  ScheduleSyncIntentResult,
} from '../core/repository.js';
import type { Database, DatabaseClient } from '../db/database.js';
import {
  applications,
  artifacts,
  auditEvents,
  authIdentities,
  authTransactions,
  cliAuthorizations,
  channels,
  devices,
  emailChallenges,
  installations,
  permissionGrants,
  refreshTokens,
  releaseReviews,
  releases,
  runs,
  scheduleChanges,
  schedules,
  scheduleWorkspaceRevisions,
  sessions,
  userPlatformRoles,
  users,
  workspaceMemberships,
  workspaces,
} from '../db/schema.js';

export class PostgresPlatformRepository implements PlatformRepository, OnModuleDestroy {
  constructor(
    private readonly database: Database,
    private readonly client: DatabaseClient,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.end();
  }

  async findLatestEmailChallenge(email: string): Promise<EmailChallengeRecord | null> {
    const row = (
      await this.database
        .select()
        .from(emailChallenges)
        .where(and(eq(emailChallenges.email, email), isNull(emailChallenges.consumedAt)))
        .orderBy(desc(emailChallenges.createdAt))
        .limit(1)
    )[0];
    return row ? mapChallenge(row) : null;
  }

  async findEmailChallengeById(id: string): Promise<EmailChallengeRecord | null> {
    const row = (
      await this.database.select().from(emailChallenges).where(eq(emailChallenges.id, id)).limit(1)
    )[0];
    return row ? mapChallenge(row) : null;
  }

  async createEmailChallenge(record: EmailChallengeRecord): Promise<void> {
    await this.database.insert(emailChallenges).values({ ...record, consumedAt: record.consumedAt ?? null });
  }

  async consumeEmailChallenge(
    id: string,
    suppliedHash: string,
    now: Date,
    maxAttempts: number,
  ): Promise<string> {
    return this.database.transaction(async (transaction) => {
      const row = (
        await transaction
          .select()
          .from(emailChallenges)
          .where(eq(emailChallenges.id, id))
          .for('update')
          .limit(1)
      )[0];
      if (!row)
        throw new DomainError(409, 'invalid_state', 'The email challenge is invalid or already consumed');
      if (row.consumedAt) invalidState('The email challenge is invalid or already consumed');
      if (row.expiresAt <= now) invalidState('The email challenge has expired');
      if (row.attempts >= maxAttempts) invalidState('The email challenge has too many failed attempts');
      const valid = constantTimeEqual(row.codeHash, suppliedHash);
      await transaction
        .update(emailChallenges)
        .set({ attempts: row.attempts + 1, ...(valid ? { consumedAt: now } : {}) })
        .where(eq(emailChallenges.id, id));
      if (!valid) invalidState('The verification code is invalid');
      return row.email;
    });
  }

  async createOidcTransaction(record: OidcTransactionRecord): Promise<void> {
    await this.database.insert(authTransactions).values({
      ...record,
      provider: record.provider ?? null,
      returnTo: record.returnTo ?? null,
      consumedAt: null,
    });
  }

  async consumeOidcTransaction(stateHash: string, now: Date): Promise<OidcTransactionRecord> {
    return this.database.transaction(async (transaction) => {
      const row = (
        await transaction
          .select()
          .from(authTransactions)
          .where(eq(authTransactions.stateHash, stateHash))
          .for('update')
          .limit(1)
      )[0];
      if (!row)
        throw new DomainError(
          409,
          'invalid_state',
          'The OIDC authorization transaction is invalid or expired',
        );
      if (row.consumedAt || row.expiresAt <= now)
        invalidState('The OIDC authorization transaction is invalid or expired');
      await transaction
        .update(authTransactions)
        .set({ consumedAt: now })
        .where(eq(authTransactions.id, row.id));
      return {
        ...row,
        provider: row.provider ?? undefined,
        returnTo: row.returnTo ?? undefined,
        consumedAt: now,
      };
    });
  }

  async createCliAuthorization(record: CliAuthorizationRecord): Promise<void> {
    await this.database.insert(cliAuthorizations).values(record);
  }

  async authorizeCliRequest(
    id: string,
    userId: string,
    codeHash: string,
    now: Date,
  ): Promise<{ redirectUri: string; state: string }> {
    return this.database.transaction(async (transaction) => {
      const record =
        (
          await transaction
            .select()
            .from(cliAuthorizations)
            .where(eq(cliAuthorizations.id, id))
            .for('update')
            .limit(1)
        )[0] ?? notFound('CLI authorization');
      if (record.expiresAt <= now || record.authorizedAt || record.consumedAt)
        invalidState('The CLI authorization request is invalid or expired');
      await transaction
        .update(cliAuthorizations)
        .set({ userId, codeHash, authorizedAt: now })
        .where(eq(cliAuthorizations.id, id));
      return { redirectUri: record.redirectUri, state: record.state };
    });
  }

  async consumeCliAuthorization(input: {
    codeHash: string;
    redirectUri: string;
    codeChallenge: string;
    now: Date;
  }): Promise<{ user: CurrentUser; offlineAccess: boolean }> {
    return this.database.transaction(async (transaction) => {
      const record = (
        await transaction
          .select()
          .from(cliAuthorizations)
          .where(eq(cliAuthorizations.codeHash, input.codeHash))
          .for('update')
          .limit(1)
      )[0];
      if (!record)
        throw new DomainError(
          409,
          'invalid_state',
          'The CLI authorization code is invalid, expired, or does not match PKCE',
        );
      const userId = record.userId;
      if (!userId)
        throw new DomainError(
          409,
          'invalid_state',
          'The CLI authorization code is invalid, expired, or does not match PKCE',
        );
      if (
        !record.authorizedAt ||
        record.consumedAt ||
        record.expiresAt <= input.now ||
        record.redirectUri !== input.redirectUri ||
        !constantTimeEqual(record.codeChallenge, input.codeChallenge)
      )
        invalidState('The CLI authorization code is invalid, expired, or does not match PKCE');
      await transaction
        .update(cliAuthorizations)
        .set({ consumedAt: input.now })
        .where(eq(cliAuthorizations.id, record.id));
      const user =
        (await transaction.select().from(users).where(eq(users.id, userId)).limit(1))[0] ?? notFound('User');
      const roles = await transaction
        .select({ role: userPlatformRoles.role })
        .from(userPlatformRoles)
        .where(eq(userPlatformRoles.userId, user.id));
      return {
        user: mapUser(
          user,
          roles.map(({ role }) => role),
        ),
        offlineAccess: record.offlineAccess,
      };
    });
  }

  async upsertIdentity(input: IdentityInput): Promise<CurrentUser> {
    return this.database.transaction(async (transaction) => {
      const identity = (
        await transaction
          .select()
          .from(authIdentities)
          .where(and(eq(authIdentities.issuer, input.issuer), eq(authIdentities.subject, input.subject)))
          .limit(1)
      )[0];
      let user = identity
        ? (await transaction.select().from(users).where(eq(users.id, identity.userId)).limit(1))[0]
        : undefined;
      if (!user) {
        const id = randomUUID();
        [user] = await transaction
          .insert(users)
          .values({ id, primaryEmail: input.email, displayName: input.displayName })
          .returning();
        if (!user) throw new Error('Failed to create user');
        if (input.platformRoles.length) {
          await transaction
            .insert(userPlatformRoles)
            .values(input.platformRoles.map((role) => ({ userId: id, role })));
        }
        const workspaceId = randomUUID();
        const slugBase =
          input.email
            .split('@')[0]
            ?.replace(/[^a-z0-9-]/g, '-')
            .replace(/^-+|-+$/g, '') || 'personal';
        await transaction.insert(workspaces).values({
          id: workspaceId,
          slug: `${slugBase.slice(0, 48)}-${workspaceId.slice(0, 8)}`,
          name: input.displayName,
          createdBy: id,
        });
        await transaction.insert(workspaceMemberships).values({ workspaceId, userId: id, role: 'owner' });
      }
      if (!identity) {
        await transaction.insert(authIdentities).values({
          id: randomUUID(),
          userId: user.id,
          issuer: input.issuer,
          subject: input.subject,
          email: input.email,
        });
      }
      const roles = await transaction
        .select({ role: userPlatformRoles.role })
        .from(userPlatformRoles)
        .where(eq(userPlatformRoles.userId, user.id));
      return mapUser(
        user,
        roles.map(({ role }) => role),
      );
    });
  }

  async createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.database.insert(sessions).values({ id: randomUUID(), userId, tokenHash, expiresAt });
  }

  async createRefreshSession(input: RefreshSessionInput): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.insert(refreshTokens).values({
        id: randomUUID(),
        familyId: input.familyId,
        userId: input.userId,
        tokenHash: input.refreshTokenHash,
        expiresAt: input.refreshExpiresAt,
        createdAt: input.now,
      });
      await transaction.insert(sessions).values({
        id: randomUUID(),
        userId: input.userId,
        tokenHash: input.accessTokenHash,
        refreshFamilyId: input.familyId,
        expiresAt: input.accessExpiresAt,
        createdAt: input.now,
      });
    });
  }

  async rotateRefreshSession(input: RotateRefreshSessionInput): Promise<RotateRefreshSessionResult> {
    return this.database.transaction(async (transaction) => {
      const refresh = (
        await transaction
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, input.refreshTokenHash))
          .for('update')
          .limit(1)
      )[0];
      if (!refresh) return { status: 'invalid' as const };
      const replayed = refresh.consumedAt !== null;
      if (refresh.consumedAt || refresh.revokedAt || refresh.expiresAt <= input.now) {
        await transaction
          .update(refreshTokens)
          .set({ revokedAt: input.now })
          .where(eq(refreshTokens.familyId, refresh.familyId));
        await transaction
          .update(sessions)
          .set({ revokedAt: input.now })
          .where(eq(sessions.refreshFamilyId, refresh.familyId));
        return { status: replayed ? ('replayed' as const) : ('invalid' as const) };
      }

      await transaction
        .update(refreshTokens)
        .set({ consumedAt: input.now })
        .where(eq(refreshTokens.id, refresh.id));
      await transaction
        .update(sessions)
        .set({ revokedAt: input.now })
        .where(and(eq(sessions.refreshFamilyId, refresh.familyId), isNull(sessions.revokedAt)));
      await transaction.insert(refreshTokens).values({
        id: randomUUID(),
        familyId: refresh.familyId,
        userId: refresh.userId,
        tokenHash: input.nextRefreshTokenHash,
        expiresAt: refresh.expiresAt,
        createdAt: input.now,
      });
      await transaction.insert(sessions).values({
        id: randomUUID(),
        userId: refresh.userId,
        tokenHash: input.nextAccessTokenHash,
        refreshFamilyId: refresh.familyId,
        expiresAt: input.nextAccessExpiresAt,
        createdAt: input.now,
      });
      const user =
        (await transaction.select().from(users).where(eq(users.id, refresh.userId)).limit(1))[0] ??
        notFound('User');
      const roles = await transaction
        .select({ role: userPlatformRoles.role })
        .from(userPlatformRoles)
        .where(eq(userPlatformRoles.userId, user.id));
      return {
        status: 'rotated' as const,
        user: mapUser(
          user,
          roles.map(({ role }) => role),
        ),
      };
    });
  }

  async findUserBySession(tokenHash: string, now: Date): Promise<CurrentUser | null> {
    const row = (
      await this.database
        .select({ user: users })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)),
        )
        .limit(1)
    )[0];
    if (!row) return null;
    const roles = await this.database
      .select({ role: userPlatformRoles.role })
      .from(userPlatformRoles)
      .where(eq(userPlatformRoles.userId, row.user.id));
    return mapUser(
      row.user,
      roles.map(({ role }) => role),
    );
  }

  async revokeSessionFamily(tokenHash: string, now: Date): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const session = (
        await transaction
          .select()
          .from(sessions)
          .where(eq(sessions.tokenHash, tokenHash))
          .for('update')
          .limit(1)
      )[0];
      if (!session) return;
      await transaction.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, session.id));
      if (!session.refreshFamilyId) return;
      await transaction
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(eq(refreshTokens.familyId, session.refreshFamilyId));
      await transaction
        .update(sessions)
        .set({ revokedAt: now })
        .where(eq(sessions.refreshFamilyId, session.refreshFamilyId));
    });
  }

  async listWorkspaces(userId: string): Promise<Workspace[]> {
    const rows = await this.database
      .select({ workspace: workspaces, role: workspaceMemberships.role })
      .from(workspaceMemberships)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
      .where(eq(workspaceMemberships.userId, userId));
    return rows.map(({ workspace, role }) => ({
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      role,
      createdAt: workspace.createdAt.toISOString(),
    }));
  }

  async createWorkspace(input: { slug: string; name: string; userId: string }): Promise<Workspace> {
    return this.database.transaction(async (transaction) => {
      if (
        (
          await transaction
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.slug, input.slug))
            .limit(1)
        )[0]
      )
        conflict('workspace_slug_exists', 'A workspace already uses that slug');
      const id = randomUUID();
      const [workspace] = await transaction
        .insert(workspaces)
        .values({ id, slug: input.slug, name: input.name, createdBy: input.userId })
        .returning();
      await transaction
        .insert(workspaceMemberships)
        .values({ workspaceId: id, userId: input.userId, role: 'owner' });
      if (!workspace) throw new Error('Failed to create workspace');
      return {
        id,
        slug: workspace.slug,
        name: workspace.name,
        role: 'owner',
        createdAt: workspace.createdAt.toISOString(),
      };
    });
  }

  async getWorkspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    return (
      (
        await this.database
          .select({ role: workspaceMemberships.role })
          .from(workspaceMemberships)
          .where(
            and(eq(workspaceMemberships.workspaceId, workspaceId), eq(workspaceMemberships.userId, userId)),
          )
          .limit(1)
      )[0]?.role ?? null
    );
  }

  async registerDevice(
    input: RegisterDeviceInput & { ownerId: string; credentialHash: string },
  ): Promise<Device> {
    return this.database.transaction(async (transaction) => {
      const existing = (
        await transaction
          .select()
          .from(devices)
          .where(
            and(
              eq(devices.ownerId, input.ownerId),
              eq(devices.publicKeyThumbprint, input.publicKeyThumbprint),
            ),
          )
          .for('update')
          .limit(1)
      )[0];
      const existingCredential = (
        await transaction
          .select({ id: devices.id })
          .from(devices)
          .where(eq(devices.credentialHash, input.credentialHash))
          .limit(1)
      )[0];
      if (existingCredential && existingCredential.id !== existing?.id) {
        conflict('device_credential_exists', 'That device credential is already registered');
      }

      const now = new Date();
      if (existing) {
        if (
          existing.status !== 'active' ||
          existing.workspaceId !== input.workspaceId ||
          existing.os !== input.os ||
          existing.arch !== input.arch
        ) {
          conflict(
            'device_key_scope_changed',
            'That device identity is already registered with a different scope or target',
          );
        }
        const [updated] = await transaction
          .update(devices)
          .set({
            name: input.name,
            agentVersion: input.agentVersion,
            credentialHash: input.credentialHash,
          })
          .where(eq(devices.id, existing.id))
          .returning();
        if (!updated) throw new Error('Failed to rotate the device credential');
        await transaction
          .insert(auditEvents)
          .values(
            newAuditEvent(
              input.workspaceId,
              { type: 'user', id: input.ownerId },
              'device.credential_rotated',
              'device',
              existing.id,
              {},
              now,
            ),
          );
        return mapDevice(updated);
      }
      const [row] = await transaction
        .insert(devices)
        .values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          ownerId: input.ownerId,
          name: input.name,
          os: input.os,
          arch: input.arch,
          agentVersion: input.agentVersion,
          publicKeyThumbprint: input.publicKeyThumbprint,
          credentialHash: input.credentialHash,
          status: 'active',
          lastSeenAt: null,
          revokedAt: null,
          createdAt: now,
        })
        .returning();
      if (!row) throw new Error('Failed to register device');

      await transaction
        .insert(auditEvents)
        .values(
          newAuditEvent(
            input.workspaceId,
            { type: 'user', id: input.ownerId },
            'device.registered',
            'device',
            row.id,
            { os: row.os, arch: row.arch },
            now,
          ),
        );
      return mapDevice(row);
    });
  }

  async findActiveDeviceByCredentialHash(credentialHash: string): Promise<Device | null> {
    const row = (
      await this.database
        .select()
        .from(devices)
        .where(and(eq(devices.credentialHash, credentialHash), eq(devices.status, 'active')))
        .limit(1)
    )[0];
    return row ? mapDevice(row) : null;
  }

  async getDevice(id: string): Promise<Device> {
    return mapDevice(
      (await this.database.select().from(devices).where(eq(devices.id, id)).limit(1))[0] ??
        notFound('Device'),
    );
  }

  async listDevices(input: ListDevicesQuery): Promise<Device[]> {
    const rows = await this.database
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.workspaceId, input.workspaceId),
          ...(input.status ? [eq(devices.status, input.status)] : []),
        ),
      )
      .orderBy(asc(devices.createdAt));
    return rows.map(mapDevice);
  }

  async revokeDevice(id: string, actorId: string): Promise<Device> {
    return this.database.transaction(async (transaction) => {
      const device =
        (await transaction.select().from(devices).where(eq(devices.id, id)).for('update').limit(1))[0] ??
        notFound('Device');
      if (device.status === 'revoked') return mapDevice(device);

      const now = new Date();
      const [updated] = await transaction
        .update(devices)
        .set({ status: 'revoked', revokedAt: now })
        .where(eq(devices.id, id))
        .returning();
      if (!updated) throw new Error('Failed to revoke device');
      await transaction
        .insert(auditEvents)
        .values(
          newAuditEvent(
            device.workspaceId,
            { type: 'user', id: actorId },
            'device.revoked',
            'device',
            device.id,
            {},
            now,
          ),
        );
      return mapDevice(updated);
    });
  }

  async requestInstallation(
    input: RequestInstallationInput & { requestedBy: string },
  ): Promise<Installation> {
    return this.database.transaction(async (transaction) => {
      const device =
        (
          await transaction
            .select()
            .from(devices)
            .where(eq(devices.id, input.deviceId))
            .for('update')
            .limit(1)
        )[0] ?? notFound('Device');
      if (device.status !== 'active') invalidState('The device has been revoked');
      if (device.workspaceId !== input.workspaceId)
        invalidState('The device does not belong to the requested workspace');

      const application =
        (
          await transaction
            .select()
            .from(applications)
            .where(eq(applications.id, input.applicationId))
            .limit(1)
        )[0] ?? notFound('Application');
      const release =
        (await transaction.select().from(releases).where(eq(releases.id, input.releaseId)).limit(1))[0] ??
        notFound('Release');
      assertDesktopRelease(application, release, input.workspaceId);
      const capabilityHash = await computeDesktopCapabilityHash(desktopCapabilities(release));
      const activeGrant = (
        await transaction
          .select({ id: permissionGrants.id })
          .from(permissionGrants)
          .where(
            and(
              eq(permissionGrants.deviceId, device.id),
              eq(permissionGrants.releaseId, release.id),
              eq(permissionGrants.capabilityHash, capabilityHash),
              eq(permissionGrants.status, 'active'),
              or(isNull(permissionGrants.expiresAt), gt(permissionGrants.expiresAt, new Date())),
            ),
          )
          .for('share')
          .limit(1)
      )[0];
      if (!activeGrant) permissionApprovalRequired();

      const existing = (
        await transaction
          .select()
          .from(installations)
          .where(
            and(
              eq(installations.deviceId, input.deviceId),
              eq(installations.applicationId, input.applicationId),
              eq(installations.releaseId, input.releaseId),
            ),
          )
          .for('update')
          .limit(1)
      )[0];
      if (existing && existing.status !== 'failed' && existing.status !== 'removed') {
        return mapInstallation(existing, input.workspaceId);
      }

      const now = new Date();
      const [installation] = existing
        ? await transaction
            .update(installations)
            .set({
              status: 'requested',
              errorCode: null,
              installedAt: null,
              updatedAt: now,
            })
            .where(eq(installations.id, existing.id))
            .returning()
        : await transaction
            .insert(installations)
            .values({
              id: randomUUID(),
              deviceId: input.deviceId,
              applicationId: input.applicationId,
              releaseId: input.releaseId,
              status: 'requested',
              errorCode: null,
              installedAt: null,
              updatedAt: now,
              createdAt: now,
            })
            .returning();
      if (!installation) throw new Error('Failed to request installation');

      const [revision] = await transaction
        .update(devices)
        .set({ installationRevision: device.installationRevision + 1 })
        .where(eq(devices.id, device.id))
        .returning({ installationRevision: devices.installationRevision });
      if (!revision) throw new Error('Failed to advance the device installation revision');

      await transaction
        .insert(auditEvents)
        .values(
          newAuditEvent(
            input.workspaceId,
            { type: 'user', id: input.requestedBy },
            'installation.requested',
            'installation',
            installation.id,
            { deviceId: device.id, releaseId: input.releaseId },
            now,
          ),
        );
      return mapInstallation(installation, input.workspaceId);
    });
  }

  async getInstallation(id: string): Promise<Installation> {
    const row =
      (
        await this.database
          .select({ installation: installations, workspaceId: devices.workspaceId })
          .from(installations)
          .innerJoin(devices, eq(devices.id, installations.deviceId))
          .where(eq(installations.id, id))
          .limit(1)
      )[0] ?? notFound('Installation');
    return mapInstallation(row.installation, row.workspaceId);
  }

  async listInstallations(input: ListInstallationsQuery): Promise<Installation[]> {
    const rows = await this.database
      .select({ installation: installations, workspaceId: devices.workspaceId })
      .from(installations)
      .innerJoin(devices, eq(devices.id, installations.deviceId))
      .where(
        and(
          eq(devices.workspaceId, input.workspaceId),
          ...(input.deviceId ? [eq(installations.deviceId, input.deviceId)] : []),
          ...(input.status ? [eq(installations.status, input.status)] : []),
        ),
      )
      .orderBy(asc(installations.createdAt));
    return rows.map(({ installation, workspaceId }) => mapInstallation(installation, workspaceId));
  }

  async syncInstallations(deviceId: string, input: InstallationSyncQuery): Promise<InstallationSyncIndex> {
    return this.database.transaction(async (transaction) => {
      const device =
        (
          await transaction.select().from(devices).where(eq(devices.id, deviceId)).for('update').limit(1)
        )[0] ?? notFound('Device');
      if (device.status !== 'active') invalidState('The device has been revoked');
      if (input.revision !== undefined && input.revision > device.installationRevision) {
        conflict('installation_revision_ahead', 'The supplied installation revision is ahead of the server');
      }
      if (input.revision === device.installationRevision) {
        return { revision: device.installationRevision, changed: false, installations: [] };
      }
      const rows = await transaction
        .select()
        .from(installations)
        .where(
          and(
            eq(installations.deviceId, device.id),
            inArray(installations.status, ['requested', 'downloading', 'installed']),
          ),
        )
        .orderBy(asc(installations.createdAt));
      if (!rows.length) {
        return { revision: device.installationRevision, changed: true, installations: [] };
      }

      const now = new Date();
      const releaseIds = [...new Set(rows.map(({ releaseId }) => releaseId))];
      const releaseRows = await transaction.select().from(releases).where(inArray(releases.id, releaseIds));
      const releaseById = new Map(releaseRows.map((release) => [release.id, release]));
      const capabilityHashByReleaseId = new Map(
        await Promise.all(
          releaseIds.map(async (releaseId) => {
            const release = releaseById.get(releaseId) ?? notFound('Release');
            const capabilities = optionalDesktopCapabilities(release);
            return [
              releaseId,
              capabilities ? await computeDesktopCapabilityHash(capabilities) : undefined,
            ] as const;
          }),
        ),
      );
      const grantRows = await transaction
        .select()
        .from(permissionGrants)
        .where(and(eq(permissionGrants.deviceId, device.id), inArray(permissionGrants.releaseId, releaseIds)))
        .for('share');
      const activeGrantKeys = new Set(
        grantRows
          .filter((grant) => permissionGrantIsActiveAt(grant, now))
          .map((grant) => permissionGrantKey(grant.releaseId, grant.capabilityHash)),
      );
      const authorizedRows = rows.filter((installation) => {
        const capabilityHash = capabilityHashByReleaseId.get(installation.releaseId);
        return (
          capabilityHash !== undefined &&
          activeGrantKeys.has(permissionGrantKey(installation.releaseId, capabilityHash))
        );
      });
      return {
        revision: device.installationRevision,
        changed: true,
        installations: authorizedRows.map((installation) =>
          mapInstallation(installation, device.workspaceId),
        ),
      };
    });
  }

  async updateInstallationStatus(input: {
    id: string;
    deviceId: string;
    status: InstallationStatus;
    errorCode?: string;
  }): Promise<Installation> {
    return this.database.transaction(async (transaction) => {
      const device =
        (
          await transaction
            .select()
            .from(devices)
            .where(eq(devices.id, input.deviceId))
            .for('update')
            .limit(1)
        )[0] ?? notFound('Device');
      if (device.status !== 'active') invalidState('The device has been revoked');
      const installation =
        (
          await transaction
            .select()
            .from(installations)
            .where(eq(installations.id, input.id))
            .for('update')
            .limit(1)
        )[0] ?? notFound('Installation');
      if (installation.deviceId !== device.id) {
        invalidState('The installation is not assigned to this device');
      }
      if (installation.status === input.status) return mapInstallation(installation, device.workspaceId);

      const allowed: Record<InstallationStatus, InstallationStatus[]> = {
        requested: ['downloading', 'failed'],
        downloading: ['installed', 'failed'],
        installed: ['removed'],
        failed: [],
        removed: [],
      };
      if (!allowed[installation.status].includes(input.status)) {
        invalidState(`Installation cannot transition from ${installation.status} to ${input.status}`);
      }

      const now = new Date();
      if (input.status === 'installed') {
        const release =
          (
            await transaction.select().from(releases).where(eq(releases.id, installation.releaseId)).limit(1)
          )[0] ?? notFound('Release');
        const capabilityHash = await computeDesktopCapabilityHash(desktopCapabilities(release));
        const activeGrant = (
          await transaction
            .select({ id: permissionGrants.id })
            .from(permissionGrants)
            .where(
              and(
                eq(permissionGrants.deviceId, device.id),
                eq(permissionGrants.releaseId, release.id),
                eq(permissionGrants.capabilityHash, capabilityHash),
                eq(permissionGrants.status, 'active'),
                or(isNull(permissionGrants.expiresAt), gt(permissionGrants.expiresAt, now)),
              ),
            )
            .for('share')
            .limit(1)
        )[0];
        if (!activeGrant) permissionApprovalRequired();
      }
      const [updated] = await transaction
        .update(installations)
        .set({
          status: input.status,
          errorCode: input.errorCode ?? null,
          updatedAt: now,
          ...(input.status === 'installed' ? { installedAt: now } : {}),
        })
        .where(eq(installations.id, installation.id))
        .returning();
      if (!updated) throw new Error('Failed to update installation status');
      await transaction
        .insert(auditEvents)
        .values(
          newAuditEvent(
            device.workspaceId,
            { type: 'device', id: device.id },
            'installation.status_changed',
            'installation',
            installation.id,
            { status: input.status },
            now,
          ),
        );
      return mapInstallation(updated, device.workspaceId);
    });
  }

  async approvePermissionGrant(input: ApprovePermissionGrantRecordInput): Promise<PermissionGrant> {
    return this.database.transaction(async (transaction) => {
      const device =
        (
          await transaction
            .select()
            .from(devices)
            .where(eq(devices.id, input.deviceId))
            .for('update')
            .limit(1)
        )[0] ?? notFound('Device');
      if (device.status !== 'active') invalidState('The device has been revoked');
      const release =
        (await transaction.select().from(releases).where(eq(releases.id, input.releaseId)).limit(1))[0] ??
        notFound('Release');
      const application =
        (
          await transaction
            .select()
            .from(applications)
            .where(eq(applications.id, release.applicationId))
            .limit(1)
        )[0] ?? notFound('Application');
      assertDesktopRelease(application, release, device.workspaceId);
      const capabilities = desktopCapabilities(release);
      const capabilityHash = await computeDesktopCapabilityHash(capabilities);
      if (capabilityHash !== input.expectedCapabilityHash) {
        conflict('permission_requirement_changed', 'The requested capability set changed before approval');
      }
      if (input.expiresAt && input.expiresAt <= input.now) {
        invalidState('Permission grant expiry must be in the future');
      }
      const [grant] = await transaction
        .insert(permissionGrants)
        .values({
          id: randomUUID(),
          workspaceId: device.workspaceId,
          deviceId: input.deviceId,
          applicationId: application.id,
          releaseId: input.releaseId,
          capabilities,
          capabilityHash,
          status: 'active',
          grantedBy: input.grantedBy,
          revokedAt: null,
          expiresAt: input.expiresAt ?? null,
          createdAt: input.now,
        })
        .onConflictDoUpdate({
          target: [permissionGrants.deviceId, permissionGrants.releaseId, permissionGrants.capabilityHash],
          set: {
            status: 'active',
            grantedBy: input.grantedBy,
            revokedAt: null,
            expiresAt: input.expiresAt ?? null,
          },
        })
        .returning();
      if (!grant) throw new Error('Failed to approve permission grant');
      await transaction
        .insert(auditEvents)
        .values(
          newAuditEvent(
            grant.workspaceId,
            { type: 'user', id: input.grantedBy },
            'permission_grant.approved',
            'permission_grant',
            grant.id,
            { capabilityHash: grant.capabilityHash, releaseId: grant.releaseId },
            input.now,
          ),
        );
      return mapPermissionGrant(grant, input.now);
    });
  }

  async getPermissionGrant(id: string): Promise<PermissionGrant> {
    const row =
      (await this.database.select().from(permissionGrants).where(eq(permissionGrants.id, id)).limit(1))[0] ??
      notFound('Permission grant');
    return mapPermissionGrant(row, new Date());
  }

  async listPermissionGrants(input: ListPermissionGrantsQuery): Promise<PermissionGrant[]> {
    const now = new Date();
    const rows = await this.database
      .select()
      .from(permissionGrants)
      .where(
        and(
          eq(permissionGrants.workspaceId, input.workspaceId),
          ...(input.deviceId ? [eq(permissionGrants.deviceId, input.deviceId)] : []),
          ...(input.applicationId ? [eq(permissionGrants.applicationId, input.applicationId)] : []),
        ),
      )
      .orderBy(desc(permissionGrants.createdAt));
    return rows
      .map((row) => mapPermissionGrant(row, now))
      .filter((grant) => !input.status || grant.status === input.status);
  }

  async revokePermissionGrant(id: string, actorId: string): Promise<PermissionGrant> {
    return this.database.transaction(async (transaction) => {
      const grant =
        (
          await transaction
            .select()
            .from(permissionGrants)
            .where(eq(permissionGrants.id, id))
            .for('update')
            .limit(1)
        )[0] ?? notFound('Permission grant');
      if (grant.status === 'revoked') return mapPermissionGrant(grant, new Date());
      const now = new Date();
      const [revoked] = await transaction
        .update(permissionGrants)
        .set({ status: 'revoked', revokedAt: now })
        .where(eq(permissionGrants.id, grant.id))
        .returning();
      if (!revoked) throw new Error('Failed to revoke permission grant');

      const affectedSchedules = await transaction
        .select()
        .from(schedules)
        .where(
          and(
            eq(schedules.workspaceId, revoked.workspaceId),
            eq(schedules.targetDeviceId, revoked.deviceId),
            eq(schedules.releaseId, revoked.releaseId),
            inArray(schedules.status, ['active', 'paused']),
          ),
        )
        .for('update');
      let disabledScheduleRevision: number | undefined;
      if (affectedSchedules.length) {
        const [revisionRow] = await transaction
          .insert(scheduleWorkspaceRevisions)
          .values({ workspaceId: revoked.workspaceId, revision: 1, updatedAt: now })
          .onConflictDoUpdate({
            target: scheduleWorkspaceRevisions.workspaceId,
            set: { revision: sql`${scheduleWorkspaceRevisions.revision} + 1`, updatedAt: now },
          })
          .returning({ revision: scheduleWorkspaceRevisions.revision });
        if (!revisionRow) throw new Error('Failed to allocate schedule revision');
        disabledScheduleRevision = revisionRow.revision;
        await transaction
          .update(schedules)
          .set({ status: 'disabled', revision: revisionRow.revision, updatedAt: now })
          .where(
            inArray(
              schedules.id,
              affectedSchedules.map(({ id: scheduleId }) => scheduleId),
            ),
          );
        await transaction.insert(scheduleChanges).values(
          affectedSchedules.map((schedule) => ({
            id: randomUUID(),
            workspaceId: schedule.workspaceId,
            revision: revisionRow.revision,
            scheduleId: schedule.id,
            targetDeviceId: schedule.targetDeviceId,
            operation: 'remove' as const,
            record: null,
            createdAt: now,
          })),
        );
      }

      const deniedRuns = await transaction
        .update(runs)
        .set({
          status: 'failed',
          errorCode: 'permission_grant_inactive',
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(runs.workspaceId, revoked.workspaceId),
            eq(runs.deviceId, revoked.deviceId),
            eq(runs.releaseId, revoked.releaseId),
            eq(runs.status, 'queued'),
          ),
        )
        .returning();

      const revocationAuditEvents = [
        newAuditEvent(
          revoked.workspaceId,
          { type: 'user', id: actorId },
          'permission_grant.revoked',
          'permission_grant',
          revoked.id,
          { capabilityHash: revoked.capabilityHash, releaseId: revoked.releaseId },
          now,
        ),
        ...affectedSchedules.map((schedule) =>
          newAuditEvent(
            schedule.workspaceId,
            { type: 'user', id: actorId },
            'schedule.permission_revoked',
            'schedule',
            schedule.id,
            { grantId: revoked.id, revision: disabledScheduleRevision },
            now,
          ),
        ),
        ...deniedRuns.map((run) =>
          newAuditEvent(
            run.workspaceId,
            { type: 'user', id: actorId },
            'run.permission_revoked',
            'run',
            run.id,
            { attempt: run.attempt, grantId: revoked.id },
            now,
          ),
        ),
      ];
      await transaction.insert(auditEvents).values(revocationAuditEvents);
      return mapPermissionGrant(revoked, now);
    });
  }

  async requireActivePermissionGrant(input: PermissionGrantRequirementInput): Promise<PermissionGrant> {
    return this.database.transaction(async (transaction) => {
      const device =
        (await transaction.select().from(devices).where(eq(devices.id, input.deviceId)).limit(1))[0] ??
        notFound('Device');
      if (device.status !== 'active') invalidState('The device has been revoked');
      const release =
        (await transaction.select().from(releases).where(eq(releases.id, input.releaseId)).limit(1))[0] ??
        notFound('Release');
      const application =
        (
          await transaction
            .select()
            .from(applications)
            .where(eq(applications.id, release.applicationId))
            .limit(1)
        )[0] ?? notFound('Application');
      assertDesktopRelease(application, release, device.workspaceId);
      const capabilityHash = await computeDesktopCapabilityHash(desktopCapabilities(release));
      const grant = (
        await transaction
          .select()
          .from(permissionGrants)
          .where(
            and(
              eq(permissionGrants.deviceId, device.id),
              eq(permissionGrants.releaseId, release.id),
              eq(permissionGrants.capabilityHash, capabilityHash),
              eq(permissionGrants.status, 'active'),
              or(isNull(permissionGrants.expiresAt), gt(permissionGrants.expiresAt, input.now)),
            ),
          )
          .for('share')
          .limit(1)
      )[0];
      return mapPermissionGrant(grant ?? permissionApprovalRequired(), input.now);
    });
  }

  async createSchedule(input: CreateScheduleInput & { createdBy: string }): Promise<Schedule> {
    return this.database.transaction(async (transaction) => {
      const device =
        (
          await transaction
            .select()
            .from(devices)
            .where(eq(devices.id, input.targetDeviceId))
            .for('update')
            .limit(1)
        )[0] ?? notFound('Device');
      if (device.status !== 'active') invalidState('The device has been revoked');
      if (device.workspaceId !== input.workspaceId)
        invalidState('The target device does not belong to the schedule workspace');

      const application =
        (
          await transaction
            .select()
            .from(applications)
            .where(eq(applications.id, input.applicationId))
            .limit(1)
        )[0] ?? notFound('Application');
      const release =
        (await transaction.select().from(releases).where(eq(releases.id, input.releaseId)).limit(1))[0] ??
        notFound('Release');
      assertDesktopRelease(application, release, input.workspaceId);

      const now = new Date();
      const capabilityHash = await computeDesktopCapabilityHash(desktopCapabilities(release));
      const activeGrant = (
        await transaction
          .select({ id: permissionGrants.id })
          .from(permissionGrants)
          .where(
            and(
              eq(permissionGrants.deviceId, device.id),
              eq(permissionGrants.releaseId, release.id),
              eq(permissionGrants.capabilityHash, capabilityHash),
              eq(permissionGrants.status, 'active'),
              or(isNull(permissionGrants.expiresAt), gt(permissionGrants.expiresAt, now)),
            ),
          )
          .for('share')
          .limit(1)
      )[0];
      if (!activeGrant) permissionApprovalRequired();
      const [revisionRow] = await transaction
        .insert(scheduleWorkspaceRevisions)
        .values({
          workspaceId: input.workspaceId,
          revision: 1,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: scheduleWorkspaceRevisions.workspaceId,
          set: { revision: sql`${scheduleWorkspaceRevisions.revision} + 1`, updatedAt: now },
        })
        .returning({ revision: scheduleWorkspaceRevisions.revision });
      if (!revisionRow) throw new Error('Failed to allocate schedule revision');

      const [schedule] = await transaction
        .insert(schedules)
        .values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          applicationId: input.applicationId,
          releaseId: input.releaseId,
          targetDeviceId: input.targetDeviceId,
          name: input.name,
          cronExpression: input.cronExpression,
          timezone: input.timezone,
          nextRunAtMs: input.nextRunAtMs,
          input: input.input,
          args: input.input.args,
          status: 'active',
          revision: revisionRow.revision,
          createdBy: input.createdBy,
          updatedAt: now,
          createdAt: now,
        })
        .returning();
      if (!schedule) throw new Error('Failed to create schedule');

      await transaction.insert(scheduleChanges).values({
        id: randomUUID(),
        workspaceId: schedule.workspaceId,
        revision: schedule.revision,
        scheduleId: schedule.id,
        targetDeviceId: schedule.targetDeviceId,
        operation: 'upsert',
        record: mapScheduleRecord(schedule, application.slug, release.version),
        createdAt: now,
      });
      await transaction
        .insert(auditEvents)
        .values(
          newAuditEvent(
            schedule.workspaceId,
            { type: 'user', id: input.createdBy },
            'schedule.created',
            'schedule',
            schedule.id,
            { revision: schedule.revision },
            now,
          ),
        );
      return mapSchedule(schedule);
    });
  }

  async getSchedule(id: string): Promise<Schedule> {
    return mapSchedule(
      (await this.database.select().from(schedules).where(eq(schedules.id, id)).limit(1))[0] ??
        notFound('Schedule'),
    );
  }

  async listSchedules(input: ListSchedulesQuery): Promise<Schedule[]> {
    const rows = await this.database
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.workspaceId, input.workspaceId),
          ...(input.targetDeviceId ? [eq(schedules.targetDeviceId, input.targetDeviceId)] : []),
          ...(input.status ? [eq(schedules.status, input.status)] : []),
        ),
      )
      .orderBy(asc(schedules.createdAt));
    return rows.map(mapSchedule);
  }

  async updateSchedule(id: string, input: UpdateScheduleInput & { actorId: string }): Promise<Schedule> {
    return this.database.transaction(async (transaction) => {
      const schedule =
        (await transaction.select().from(schedules).where(eq(schedules.id, id)).for('update').limit(1))[0] ??
        notFound('Schedule');
      if (schedule.revision !== input.expectedRevision)
        conflict('schedule_changed', 'The schedule changed since it was read');

      const targetDeviceId =
        input.targetDeviceId === undefined ? schedule.targetDeviceId : input.targetDeviceId;
      const activeTargetDeviceId =
        targetDeviceId ??
        invalidState('Desktop schedules must target a device with an active permission grant');
      const device =
        (
          await transaction
            .select()
            .from(devices)
            .where(eq(devices.id, activeTargetDeviceId))
            .for('update')
            .limit(1)
        )[0] ?? notFound('Device');
      if (device.status !== 'active') invalidState('The device has been revoked');
      if (device.workspaceId !== schedule.workspaceId)
        invalidState('The target device does not belong to the schedule workspace');

      const application =
        (
          await transaction
            .select()
            .from(applications)
            .where(eq(applications.id, schedule.applicationId))
            .limit(1)
        )[0] ?? notFound('Application');
      const releaseId = input.releaseId ?? schedule.releaseId;
      const release =
        (await transaction.select().from(releases).where(eq(releases.id, releaseId)).limit(1))[0] ??
        notFound('Release');
      assertDesktopRelease(application, release, schedule.workspaceId);

      const now = new Date();
      const capabilityHash = await computeDesktopCapabilityHash(desktopCapabilities(release));
      const activeGrant = (
        await transaction
          .select({ id: permissionGrants.id })
          .from(permissionGrants)
          .where(
            and(
              eq(permissionGrants.deviceId, device.id),
              eq(permissionGrants.releaseId, release.id),
              eq(permissionGrants.capabilityHash, capabilityHash),
              eq(permissionGrants.status, 'active'),
              or(isNull(permissionGrants.expiresAt), gt(permissionGrants.expiresAt, now)),
            ),
          )
          .limit(1)
      )[0];
      if (!activeGrant) permissionApprovalRequired();
      const [revisionRow] = await transaction
        .insert(scheduleWorkspaceRevisions)
        .values({
          workspaceId: schedule.workspaceId,
          revision: 1,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: scheduleWorkspaceRevisions.workspaceId,
          set: { revision: sql`${scheduleWorkspaceRevisions.revision} + 1`, updatedAt: now },
        })
        .returning({ revision: scheduleWorkspaceRevisions.revision });
      if (!revisionRow) throw new Error('Failed to allocate schedule revision');

      const [updated] = await transaction
        .update(schedules)
        .set({
          ...(input.releaseId !== undefined ? { releaseId: input.releaseId } : {}),
          ...(input.targetDeviceId !== undefined ? { targetDeviceId: input.targetDeviceId } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.cronExpression !== undefined ? { cronExpression: input.cronExpression } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.nextRunAtMs !== undefined ? { nextRunAtMs: input.nextRunAtMs } : {}),
          ...(input.input !== undefined ? { input: input.input, args: input.input.args } : {}),
          revision: revisionRow.revision,
          updatedAt: now,
        })
        .where(eq(schedules.id, schedule.id))
        .returning();
      if (!updated) throw new Error('Failed to update schedule');

      if (schedule.targetDeviceId !== updated.targetDeviceId) {
        await transaction.insert(scheduleChanges).values({
          id: randomUUID(),
          workspaceId: schedule.workspaceId,
          revision: updated.revision,
          scheduleId: schedule.id,
          targetDeviceId: schedule.targetDeviceId,
          operation: 'remove',
          record: null,
          createdAt: now,
        });
      }
      await transaction.insert(scheduleChanges).values({
        id: randomUUID(),
        workspaceId: updated.workspaceId,
        revision: updated.revision,
        scheduleId: updated.id,
        targetDeviceId: updated.targetDeviceId,
        operation: 'upsert',
        record: mapScheduleRecord(updated, application.slug, release.version),
        createdAt: now,
      });
      await transaction
        .insert(auditEvents)
        .values(
          newAuditEvent(
            updated.workspaceId,
            { type: 'user', id: input.actorId },
            'schedule.updated',
            'schedule',
            updated.id,
            { revision: updated.revision },
            now,
          ),
        );
      return mapSchedule(updated);
    });
  }

  async pauseSchedule(id: string, input: PauseScheduleInput & { actorId: string }): Promise<Schedule> {
    return this.database.transaction(async (transaction) => {
      const schedule =
        (await transaction.select().from(schedules).where(eq(schedules.id, id)).for('update').limit(1))[0] ??
        notFound('Schedule');
      if (schedule.revision !== input.expectedRevision)
        conflict('schedule_changed', 'The schedule changed since it was read');
      const nextStatus = input.paused ? 'paused' : 'active';
      if (schedule.status === nextStatus) return mapSchedule(schedule);

      const application =
        (
          await transaction
            .select()
            .from(applications)
            .where(eq(applications.id, schedule.applicationId))
            .limit(1)
        )[0] ?? notFound('Application');
      const release =
        (await transaction.select().from(releases).where(eq(releases.id, schedule.releaseId)).limit(1))[0] ??
        notFound('Release');
      const now = new Date();
      if (!input.paused) {
        const targetDeviceId =
          schedule.targetDeviceId ??
          invalidState('Desktop schedules must target a device with an active permission grant');
        const device =
          (
            await transaction
              .select()
              .from(devices)
              .where(eq(devices.id, targetDeviceId))
              .for('update')
              .limit(1)
          )[0] ?? notFound('Device');
        if (device.status !== 'active') invalidState('The device has been revoked');
        if (device.workspaceId !== schedule.workspaceId)
          invalidState('The target device does not belong to the schedule workspace');
        assertDesktopRelease(application, release, schedule.workspaceId);
        const capabilityHash = await computeDesktopCapabilityHash(desktopCapabilities(release));
        const activeGrant = (
          await transaction
            .select({ id: permissionGrants.id })
            .from(permissionGrants)
            .where(
              and(
                eq(permissionGrants.deviceId, device.id),
                eq(permissionGrants.releaseId, release.id),
                eq(permissionGrants.capabilityHash, capabilityHash),
                eq(permissionGrants.status, 'active'),
                or(isNull(permissionGrants.expiresAt), gt(permissionGrants.expiresAt, now)),
              ),
            )
            .limit(1)
        )[0];
        if (!activeGrant) permissionApprovalRequired();
      }
      const [revisionRow] = await transaction
        .insert(scheduleWorkspaceRevisions)
        .values({
          workspaceId: schedule.workspaceId,
          revision: 1,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: scheduleWorkspaceRevisions.workspaceId,
          set: { revision: sql`${scheduleWorkspaceRevisions.revision} + 1`, updatedAt: now },
        })
        .returning({ revision: scheduleWorkspaceRevisions.revision });
      if (!revisionRow) throw new Error('Failed to allocate schedule revision');

      const [updated] = await transaction
        .update(schedules)
        .set({
          status: nextStatus,
          revision: revisionRow.revision,
          updatedAt: now,
        })
        .where(eq(schedules.id, schedule.id))
        .returning();
      if (!updated) throw new Error('Failed to update schedule status');
      await transaction.insert(scheduleChanges).values({
        id: randomUUID(),
        workspaceId: updated.workspaceId,
        revision: updated.revision,
        scheduleId: updated.id,
        targetDeviceId: updated.targetDeviceId,
        operation: 'upsert',
        record: mapScheduleRecord(updated, application.slug, release.version),
        createdAt: now,
      });
      await transaction
        .insert(auditEvents)
        .values(
          newAuditEvent(
            updated.workspaceId,
            { type: 'user', id: input.actorId },
            input.paused ? 'schedule.paused' : 'schedule.resumed',
            'schedule',
            updated.id,
            { revision: updated.revision },
            now,
          ),
        );
      return mapSchedule(updated);
    });
  }

  async syncSchedules(deviceId: string, input: ScheduleSyncQuery): Promise<ScheduleSyncIntentResult> {
    return this.database.transaction(
      async (transaction) => {
        const device =
          (
            await transaction.select().from(devices).where(eq(devices.id, deviceId)).for('update').limit(1)
          )[0] ?? notFound('Device');
        if (device.status !== 'active') invalidState('The device has been revoked');
        const now = new Date();
        await transaction.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, device.id));

        const grantRows = await transaction
          .select()
          .from(permissionGrants)
          .where(eq(permissionGrants.deviceId, device.id))
          .for('share');
        const revisionRow = (
          await transaction
            .select()
            .from(scheduleWorkspaceRevisions)
            .where(eq(scheduleWorkspaceRevisions.workspaceId, device.workspaceId))
            .for('update')
            .limit(1)
        )[0];
        let currentRevision = revisionRow?.revision ?? 0;
        if (input.revision !== undefined && input.revision > currentRevision) {
          conflict('schedule_revision_ahead', 'The supplied schedule revision is ahead of the server');
        }

        const currentSchedules = await transaction
          .select()
          .from(schedules)
          .where(
            and(
              eq(schedules.workspaceId, device.workspaceId),
              or(isNull(schedules.targetDeviceId), eq(schedules.targetDeviceId, device.id)),
            ),
          )
          .orderBy(asc(schedules.createdAt))
          .for('update');
        const releaseIds = [...new Set(currentSchedules.map(({ releaseId }) => releaseId))];
        const releaseRows = releaseIds.length
          ? await transaction.select().from(releases).where(inArray(releases.id, releaseIds))
          : [];
        const releaseById = new Map(releaseRows.map((release) => [release.id, release]));
        const capabilityHashByReleaseId = new Map(
          await Promise.all(
            releaseIds.map(async (releaseId) => {
              const release = releaseById.get(releaseId) ?? notFound('Release');
              const capabilities = optionalDesktopCapabilities(release);
              return [
                releaseId,
                capabilities ? await computeDesktopCapabilityHash(capabilities) : undefined,
              ] as const;
            }),
          ),
        );
        const activeGrantKeys = new Set(
          grantRows
            .filter((grant) => permissionGrantIsActiveAt(grant, now))
            .map((grant) => permissionGrantKey(grant.releaseId, grant.capabilityHash)),
        );
        const authorizedScheduleIds = new Set(
          currentSchedules
            .filter((schedule) => {
              const capabilityHash = capabilityHashByReleaseId.get(schedule.releaseId);
              return (
                schedule.status !== 'disabled' &&
                schedule.targetDeviceId === device.id &&
                capabilityHash !== undefined &&
                activeGrantKeys.has(permissionGrantKey(schedule.releaseId, capabilityHash))
              );
            })
            .map(({ id: scheduleId }) => scheduleId),
        );
        const unauthorizedSchedules = currentSchedules.filter(
          (schedule) => schedule.status !== 'disabled' && !authorizedScheduleIds.has(schedule.id),
        );
        if (unauthorizedSchedules.length) {
          const [nextRevisionRow] = await transaction
            .insert(scheduleWorkspaceRevisions)
            .values({ workspaceId: device.workspaceId, revision: 1, updatedAt: now })
            .onConflictDoUpdate({
              target: scheduleWorkspaceRevisions.workspaceId,
              set: { revision: sql`${scheduleWorkspaceRevisions.revision} + 1`, updatedAt: now },
            })
            .returning({ revision: scheduleWorkspaceRevisions.revision });
          if (!nextRevisionRow) throw new Error('Failed to allocate schedule revision');
          currentRevision = nextRevisionRow.revision;
          await transaction
            .update(schedules)
            .set({ status: 'disabled', revision: currentRevision, updatedAt: now })
            .where(
              inArray(
                schedules.id,
                unauthorizedSchedules.map(({ id: scheduleId }) => scheduleId),
              ),
            );
          await transaction.insert(scheduleChanges).values(
            unauthorizedSchedules.map((schedule) => ({
              id: randomUUID(),
              workspaceId: schedule.workspaceId,
              revision: currentRevision,
              scheduleId: schedule.id,
              targetDeviceId: schedule.targetDeviceId,
              operation: 'remove' as const,
              record: null,
              createdAt: now,
            })),
          );
          await transaction
            .insert(auditEvents)
            .values(
              unauthorizedSchedules.map((schedule) =>
                newAuditEvent(
                  schedule.workspaceId,
                  { type: 'device', id: device.id },
                  'schedule.permission_expired',
                  'schedule',
                  schedule.id,
                  { revision: currentRevision },
                  now,
                ),
              ),
            );
        }

        const applicationIds = [...new Set(currentSchedules.map(({ applicationId }) => applicationId))];
        const applicationRows = applicationIds.length
          ? await transaction.select().from(applications).where(inArray(applications.id, applicationIds))
          : [];
        const applicationById = new Map(applicationRows.map((application) => [application.id, application]));
        if (input.revision === undefined) {
          return {
            kind: 'snapshot',
            snapshot: {
              revision: currentRevision,
              schedules: currentSchedules
                .filter(
                  (schedule) => schedule.status !== 'disabled' && authorizedScheduleIds.has(schedule.id),
                )
                .map((schedule) => {
                  const application = applicationById.get(schedule.applicationId) ?? notFound('Application');
                  const release = releaseById.get(schedule.releaseId) ?? notFound('Release');
                  return mapScheduleRecord(schedule, application.slug, release.version);
                }),
            },
          };
        }

        const changes = await transaction
          .select()
          .from(scheduleChanges)
          .where(
            and(
              eq(scheduleChanges.workspaceId, device.workspaceId),
              gt(scheduleChanges.revision, input.revision),
              or(isNull(scheduleChanges.targetDeviceId), eq(scheduleChanges.targetDeviceId, device.id)),
            ),
          )
          .orderBy(asc(scheduleChanges.revision));
        changes.sort(
          (left, right) =>
            left.revision - right.revision ||
            (left.operation === right.operation ? 0 : left.operation === 'remove' ? -1 : 1),
        );
        const upserts = new Map<string, ScheduleRecordIntent>();
        const removed = new Set<string>();
        for (const change of changes) {
          if (change.operation === 'remove') {
            upserts.delete(change.scheduleId);
            removed.add(change.scheduleId);
          } else if (change.record) {
            if (authorizedScheduleIds.has(change.scheduleId)) {
              removed.delete(change.scheduleId);
              upserts.set(change.scheduleId, change.record);
            } else {
              upserts.delete(change.scheduleId);
              removed.add(change.scheduleId);
            }
          }
        }
        return {
          kind: 'delta',
          delta: {
            fromRevision: input.revision,
            toRevision: currentRevision,
            upserts: [...upserts.values()],
            removedScheduleIds: [...removed],
          },
        };
      },
      { isolationLevel: 'repeatable read' },
    );
  }

  async createManualRun(input: CreateManualRunInput & { triggeredBy: string }): Promise<Run> {
    return this.database.transaction(async (transaction) => {
      const device =
        (
          await transaction
            .select()
            .from(devices)
            .where(eq(devices.id, input.deviceId))
            .for('update')
            .limit(1)
        )[0] ?? notFound('Device');
      if (device.status !== 'active') invalidState('The device has been revoked');
      if (device.workspaceId !== input.workspaceId)
        invalidState('The device does not belong to the run workspace');

      const application =
        (
          await transaction
            .select()
            .from(applications)
            .where(eq(applications.id, input.applicationId))
            .limit(1)
        )[0] ?? notFound('Application');
      const release =
        (await transaction.select().from(releases).where(eq(releases.id, input.releaseId)).limit(1))[0] ??
        notFound('Release');
      assertDesktopRelease(application, release, input.workspaceId);
      const capabilities = desktopCapabilities(release);
      const now = new Date();
      const capabilityHash = await computeDesktopCapabilityHash(capabilities);
      const activeGrant = (
        await transaction
          .select({ id: permissionGrants.id })
          .from(permissionGrants)
          .where(
            and(
              eq(permissionGrants.deviceId, device.id),
              eq(permissionGrants.releaseId, release.id),
              eq(permissionGrants.capabilityHash, capabilityHash),
              eq(permissionGrants.status, 'active'),
              or(isNull(permissionGrants.expiresAt), gt(permissionGrants.expiresAt, now)),
            ),
          )
          .for('share')
          .limit(1)
      )[0];
      if (!activeGrant) permissionApprovalRequired();
      const installation =
        (
          await transaction
            .select()
            .from(installations)
            .where(
              and(
                eq(installations.deviceId, input.deviceId),
                eq(installations.applicationId, input.applicationId),
                eq(installations.releaseId, input.releaseId),
                eq(installations.status, 'installed'),
              ),
            )
            .for('update')
            .limit(1)
        )[0] ??
        invalidState('The approved desktop release must be installed on the target device before it can run');

      const [run] = await transaction
        .insert(runs)
        .values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          scheduleId: null,
          installationId: installation.id,
          deviceId: input.deviceId,
          applicationId: input.applicationId,
          releaseId: input.releaseId,
          trigger: 'manual',
          status: 'queued',
          attempt: 1,
          input: input.input,
          result: null,
          requiresElevation: capabilities.some(
            (capability) => capability.kind === 'lifecycle' && capability.elevation === 'user-approved',
          ),
          errorCode: null,
          cancelRequestedAt: null,
          triggeredBy: input.triggeredBy,
          queuedAt: now,
          claimedAt: null,
          startedAt: null,
          finishedAt: null,
          updatedAt: now,
        })
        .returning();
      if (!run) throw new Error('Failed to create run');
      await transaction
        .insert(auditEvents)
        .values(
          newAuditEvent(
            run.workspaceId,
            { type: 'user', id: input.triggeredBy },
            'run.created',
            'run',
            run.id,
            { deviceId: run.deviceId },
            now,
          ),
        );
      return mapRun(run);
    });
  }

  async getRun(id: string): Promise<Run> {
    return mapRun(
      (await this.database.select().from(runs).where(eq(runs.id, id)).limit(1))[0] ?? notFound('Run'),
    );
  }

  async listRuns(input: ListRunsQuery): Promise<Run[]> {
    const rows = await this.database
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, input.workspaceId),
          ...(input.deviceId ? [eq(runs.deviceId, input.deviceId)] : []),
          ...(input.scheduleId ? [eq(runs.scheduleId, input.scheduleId)] : []),
          ...(input.trigger ? [eq(runs.trigger, input.trigger)] : []),
          ...(input.status ? [eq(runs.status, input.status)] : []),
        ),
      )
      .orderBy(asc(runs.queuedAt));
    return rows.map(mapRun);
  }

  async cancelRun(id: string, actorId: string): Promise<Run> {
    return this.database.transaction(async (transaction) => {
      const run =
        (await transaction.select().from(runs).where(eq(runs.id, id)).for('update').limit(1))[0] ??
        notFound('Run');
      if (run.status === 'cancelled') return mapRun(run);
      if (run.status === 'succeeded' || run.status === 'failed') {
        invalidState('A completed run cannot be cancelled');
      }
      if (run.cancelRequestedAt) return mapRun(run);
      const now = new Date();
      const queued = run.status === 'queued';
      const [updated] = await transaction
        .update(runs)
        .set({
          cancelRequestedAt: now,
          ...(queued ? { status: 'cancelled' as const, finishedAt: now } : {}),
          updatedAt: now,
        })
        .where(eq(runs.id, run.id))
        .returning();
      if (!updated) throw new Error('Failed to cancel run');
      await transaction
        .insert(auditEvents)
        .values(
          newAuditEvent(
            run.workspaceId,
            { type: 'user', id: actorId },
            queued ? 'run.cancelled' : 'run.cancel_requested',
            'run',
            run.id,
            queued ? {} : { attempt: run.attempt },
            now,
          ),
        );
      return mapRun(updated);
    });
  }

  async claimRuns(deviceId: string, input: ClaimRunsInput): Promise<AuthorizedRunClaimRecord[]> {
    return this.database.transaction(async (transaction) => {
      const device =
        (
          await transaction.select().from(devices).where(eq(devices.id, deviceId)).for('update').limit(1)
        )[0] ?? notFound('Device');
      if (device.status !== 'active') invalidState('The device has been revoked');
      const now = new Date();
      await transaction.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, device.id));

      const grantRows = await transaction
        .select()
        .from(permissionGrants)
        .where(eq(permissionGrants.deviceId, device.id))
        .for('share');
      const claimed = await transaction
        .select()
        .from(runs)
        .where(and(eq(runs.deviceId, device.id), eq(runs.status, 'queued')))
        .orderBy(asc(runs.queuedAt))
        .for('update', { skipLocked: true })
        .limit(input.limit);
      if (!claimed.length) return [];

      const applicationRows = await transaction
        .select()
        .from(applications)
        .where(inArray(applications.id, [...new Set(claimed.map(({ applicationId }) => applicationId))]));
      const releaseRows = await transaction
        .select()
        .from(releases)
        .where(inArray(releases.id, [...new Set(claimed.map(({ releaseId }) => releaseId))]));
      const applicationById = new Map(applicationRows.map((application) => [application.id, application]));
      const releaseById = new Map(releaseRows.map((release) => [release.id, release]));
      const releaseIds = [...new Set(claimed.map(({ releaseId }) => releaseId))];
      const capabilityHashByReleaseId = new Map(
        await Promise.all(
          releaseIds.map(async (releaseId) => {
            const release = releaseById.get(releaseId) ?? notFound('Release');
            const capabilities = optionalDesktopCapabilities(release);
            return [
              releaseId,
              capabilities ? await computeDesktopCapabilityHash(capabilities) : undefined,
            ] as const;
          }),
        ),
      );
      const activeGrantKeys = new Set(
        grantRows
          .filter((grant) => permissionGrantIsActiveAt(grant, now))
          .map((grant) => permissionGrantKey(grant.releaseId, grant.capabilityHash)),
      );
      const authorizedRuns = claimed.filter((run) => {
        const capabilityHash = capabilityHashByReleaseId.get(run.releaseId);
        return (
          capabilityHash !== undefined &&
          activeGrantKeys.has(permissionGrantKey(run.releaseId, capabilityHash))
        );
      });
      const authorizedRunIds = new Set(authorizedRuns.map(({ id: runId }) => runId));
      const deniedRuns = claimed.filter((run) => !authorizedRunIds.has(run.id));
      if (authorizedRuns.length) {
        await transaction
          .update(runs)
          .set({ status: 'dispatched', claimedAt: now, updatedAt: now })
          .where(
            inArray(
              runs.id,
              authorizedRuns.map(({ id: runId }) => runId),
            ),
          );
      }
      if (deniedRuns.length) {
        await transaction
          .update(runs)
          .set({
            status: 'failed',
            errorCode: 'permission_grant_inactive',
            finishedAt: now,
            updatedAt: now,
          })
          .where(
            inArray(
              runs.id,
              deniedRuns.map(({ id: runId }) => runId),
            ),
          );
      }
      await transaction
        .insert(auditEvents)
        .values([
          ...authorizedRuns.map((run) =>
            newAuditEvent(
              run.workspaceId,
              { type: 'device', id: device.id },
              'run.claimed',
              'run',
              run.id,
              { attempt: run.attempt },
              now,
            ),
          ),
          ...deniedRuns.map((run) =>
            newAuditEvent(
              run.workspaceId,
              { type: 'device', id: device.id },
              'run.permission_denied',
              'run',
              run.id,
              { attempt: run.attempt },
              now,
            ),
          ),
        ]);
      return authorizedRuns.map((run) => {
        const application = applicationById.get(run.applicationId) ?? notFound('Application');
        const release = releaseById.get(run.releaseId) ?? notFound('Release');
        const capabilityHash = capabilityHashByReleaseId.get(run.releaseId) ?? permissionApprovalRequired();
        const grant =
          grantRows.find(
            (candidate) =>
              candidate.releaseId === run.releaseId &&
              candidate.capabilityHash === capabilityHash &&
              permissionGrantIsActiveAt(candidate, now),
          ) ?? permissionApprovalRequired();
        return {
          runId: run.id,
          attempt: run.attempt,
          appId: application.slug,
          version: release.version,
          args: mapExecutionInput(run.input).args,
          requiresElevation: run.requiresElevation,
          applicationId: run.applicationId,
          releaseId: run.releaseId,
          capabilityHash,
          grantExpiresAt: grant.expiresAt?.toISOString() ?? null,
        };
      });
    });
  }

  async listRunCancellations(deviceId: string): Promise<RunCancellation[]> {
    return this.database.transaction(async (transaction) => {
      const device =
        (
          await transaction.select().from(devices).where(eq(devices.id, deviceId)).for('update').limit(1)
        )[0] ?? notFound('Device');
      if (device.status !== 'active') invalidState('The device has been revoked');
      const now = new Date();
      await transaction.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, device.id));
      const rows = await transaction
        .select({
          runId: runs.id,
          attempt: runs.attempt,
          cancelRequestedAt: runs.cancelRequestedAt,
        })
        .from(runs)
        .where(
          and(
            eq(runs.deviceId, device.id),
            isNotNull(runs.cancelRequestedAt),
            inArray(runs.status, ['dispatched', 'running', 'needs_user_approval']),
          ),
        )
        .orderBy(asc(runs.cancelRequestedAt));
      return rows.map((row) => ({
        runId: row.runId,
        attempt: row.attempt,
        cancelRequestedAt: row.cancelRequestedAt!.toISOString(),
      }));
    });
  }

  async reportRun(input: ReportRunStatusInput & { runId: string; deviceId: string }): Promise<Run> {
    return this.database.transaction(async (transaction) => {
      const device =
        (
          await transaction
            .select()
            .from(devices)
            .where(eq(devices.id, input.deviceId))
            .for('update')
            .limit(1)
        )[0] ?? notFound('Device');
      if (device.status !== 'active') invalidState('The device has been revoked');
      const now = new Date();
      await transaction.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, device.id));

      const run =
        (await transaction.select().from(runs).where(eq(runs.id, input.runId)).for('update').limit(1))[0] ??
        notFound('Run');
      if (run.deviceId !== device.id) invalidState('The run is not assigned to this device');
      if (run.attempt !== input.attempt)
        conflict('run_attempt_changed', 'The run attempt changed before the device report arrived');
      const mappedRun = mapRun(run);
      if (run.status === input.status) {
        if (sameRunReport(mappedRun, input)) return mappedRun;
        conflict(
          'run_report_mismatch',
          'A report for this run attempt and status was already accepted with different data',
        );
      }
      if (input.status === 'cancelled' && !run.cancelRequestedAt)
        invalidState('A device can report cancellation only after the server requests it');
      const allowed: Record<Run['status'], Run['status'][]> = {
        queued: [],
        dispatched: ['running', 'succeeded', 'failed', 'cancelled', 'needs_user_approval'],
        running: ['succeeded', 'failed', 'cancelled', 'needs_user_approval'],
        needs_user_approval: ['running', 'failed', 'cancelled'],
        succeeded: [],
        failed: [],
        cancelled: [],
      };
      if (!allowed[run.status].includes(input.status))
        invalidState(`Run cannot transition from ${run.status} to ${input.status}`);

      const [updated] = await transaction
        .update(runs)
        .set({
          status: input.status,
          errorCode: input.errorCode ?? null,
          ...(input.result !== undefined ? { result: input.result } : {}),
          ...(input.status === 'running' && !run.startedAt ? { startedAt: now } : {}),
          ...(input.status === 'succeeded' || input.status === 'failed' || input.status === 'cancelled'
            ? { finishedAt: now }
            : {}),
          updatedAt: now,
        })
        .where(eq(runs.id, run.id))
        .returning();
      if (!updated) throw new Error('Failed to report run status');
      await transaction
        .insert(auditEvents)
        .values(
          newAuditEvent(
            run.workspaceId,
            { type: 'device', id: device.id },
            'run.status_reported',
            'run',
            run.id,
            { status: input.status, attempt: input.attempt },
            now,
          ),
        );
      return mapRun(updated);
    });
  }

  async listAuditEvents(workspaceId: string): Promise<AuditEventRecord[]> {
    const rows = await this.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, workspaceId),
          or(isNotNull(auditEvents.actorId), isNotNull(auditEvents.actorDeviceId)),
        ),
      )
      .orderBy(asc(auditEvents.createdAt));
    return rows.map((row) => {
      if ((row.actorId === null) === (row.actorDeviceId === null)) {
        throw new Error('Audit event stored in PostgreSQL must have exactly one actor');
      }
      return {
        id: row.id,
        workspaceId,
        actorType: row.actorDeviceId ? 'device' : 'user',
        actorId: row.actorDeviceId ?? row.actorId!,
        action: row.action,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        metadata: row.metadata,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  async createApplication(input: ApplicationInput): Promise<Application> {
    return this.database.transaction(async (transaction) => {
      if (
        (
          await transaction
            .select({ id: applications.id })
            .from(applications)
            .where(and(eq(applications.workspaceId, input.workspaceId), eq(applications.slug, input.slug)))
            .limit(1)
        )[0]
      )
        conflict('application_slug_exists', 'An application already uses that slug in this workspace');
      const [row] = await transaction
        .insert(applications)
        .values({
          id: randomUUID(),
          ...input,
          defaultLocale: input.defaultLocale ?? 'en-US',
          localizations: input.localizations ?? {},
        })
        .returning();
      if (!row) throw new Error('Failed to create application');
      await transaction
        .insert(auditEvents)
        .values(
          newAuditEvent(
            row.workspaceId,
            { type: 'user', id: input.createdBy },
            'application.created',
            'application',
            row.id,
            { kind: row.kind, slug: row.slug },
            row.createdAt,
          ),
        );
      return mapApplication(row);
    });
  }

  async listApplications(workspaceId: string): Promise<Application[]> {
    return (
      await this.database.select().from(applications).where(eq(applications.workspaceId, workspaceId))
    ).map(mapApplication);
  }

  async getApplication(id: string): Promise<Application> {
    return mapApplication(
      (await this.database.select().from(applications).where(eq(applications.id, id)).limit(1))[0] ??
        notFound('Application'),
    );
  }

  async createRelease(input: ReleaseInput): Promise<Release> {
    return this.database.transaction(async (transaction) => {
      const application =
        (
          await transaction
            .select()
            .from(applications)
            .where(eq(applications.id, input.applicationId))
            .limit(1)
        )[0] ?? notFound('Application');
      if (
        (
          await transaction
            .select({ id: releases.id })
            .from(releases)
            .where(and(eq(releases.applicationId, input.applicationId), eq(releases.version, input.version)))
            .limit(1)
        )[0]
      )
        conflict('release_version_exists', 'Release versions are immutable and cannot be reused');
      const [row] = await transaction
        .insert(releases)
        .values({ id: randomUUID(), ...input, validationEvidence: [], status: 'draft' })
        .returning();
      if (!row) throw new Error('Failed to create release');
      await transaction
        .insert(auditEvents)
        .values(
          newAuditEvent(
            application.workspaceId,
            { type: 'user', id: input.createdBy },
            'release.created',
            'release',
            row.id,
            { applicationId: application.id, version: row.version },
            row.createdAt,
          ),
        );
      return mapRelease(row);
    });
  }

  async listReleases(input: ListReleasesQuery & { workspaceId: string }): Promise<ReleaseListItem[]> {
    const conditions = [eq(applications.workspaceId, input.workspaceId)];
    if (input.applicationId) conditions.push(eq(releases.applicationId, input.applicationId));
    if (input.status) conditions.push(eq(releases.status, input.status));
    if (input.kind) conditions.push(eq(applications.kind, input.kind));

    const rows = await this.database
      .select({ application: applications, release: releases })
      .from(releases)
      .innerJoin(applications, eq(applications.id, releases.applicationId))
      .where(and(...conditions))
      .orderBy(desc(releases.createdAt));
    if (rows.length === 0) return [];

    const releaseIds = rows.map(({ release }) => release.id);
    const [artifactRows, reviewRows] = await Promise.all([
      this.database
        .select({ releaseId: artifacts.releaseId })
        .from(artifacts)
        .where(inArray(artifacts.releaseId, releaseIds)),
      this.database
        .select({ releaseId: releaseReviews.releaseId })
        .from(releaseReviews)
        .where(inArray(releaseReviews.releaseId, releaseIds)),
    ]);
    const artifactCounts = countByRelease(artifactRows);
    const reviewCounts = countByRelease(reviewRows);
    return rows.map(({ application, release }) => ({
      application: mapApplication(application),
      release: mapRelease(release),
      artifactCount: artifactCounts.get(release.id) ?? 0,
      reviewCount: reviewCounts.get(release.id) ?? 0,
    }));
  }

  async getRelease(id: string): Promise<Release> {
    return mapRelease(
      (await this.database.select().from(releases).where(eq(releases.id, id)).limit(1))[0] ??
        notFound('Release'),
    );
  }

  async createArtifact(input: ArtifactInput): Promise<Artifact> {
    return this.database.transaction(async (transaction) => {
      const release =
        (
          await transaction
            .select()
            .from(releases)
            .where(eq(releases.id, input.releaseId))
            .for('update')
            .limit(1)
        )[0] ?? notFound('Release');
      if (release.status !== 'draft' && release.status !== 'uploading')
        invalidState('Artifacts can only be registered while a release is uploading');
      if (
        (
          await transaction
            .select({ id: artifacts.id })
            .from(artifacts)
            .where(and(eq(artifacts.releaseId, input.releaseId), eq(artifacts.fileName, input.fileName)))
            .limit(1)
        )[0]
      )
        conflict('artifact_name_exists', 'That artifact name is already registered');
      const [row] = await transaction
        .insert(artifacts)
        .values({ id: randomUUID(), ...input, validationEvidence: [], status: 'pending_upload' })
        .returning();
      if (!row) throw new Error('Failed to create artifact');
      if (release.status === 'draft') {
        await transaction.update(releases).set({ status: 'uploading' }).where(eq(releases.id, release.id));
      }
      return mapArtifact(row);
    });
  }

  async finalizeArtifact(id: string, etag: string | undefined): Promise<Artifact> {
    return this.database.transaction(async (transaction) => {
      const row =
        (await transaction.select().from(artifacts).where(eq(artifacts.id, id)).for('update').limit(1))[0] ??
        notFound('Artifact');
      if (row.status !== 'pending_upload') invalidState('The artifact upload has already been finalized');
      const [updated] = await transaction
        .update(artifacts)
        .set({ status: 'uploaded', finalizedAt: new Date(), etag: etag ?? null })
        .where(eq(artifacts.id, id))
        .returning();
      if (!updated) throw new Error('Failed to finalize artifact');
      return mapArtifact(updated);
    });
  }

  async getArtifact(id: string): Promise<Artifact> {
    return mapArtifact(
      (await this.database.select().from(artifacts).where(eq(artifacts.id, id)).limit(1))[0] ??
        notFound('Artifact'),
    );
  }

  async submitRelease(id: string): Promise<ReleaseStatusView> {
    return this.database.transaction(async (transaction) => {
      const release =
        (await transaction.select().from(releases).where(eq(releases.id, id)).for('update').limit(1))[0] ??
        notFound('Release');
      const releaseArtifacts = await transaction.select().from(artifacts).where(eq(artifacts.releaseId, id));
      if (release.status !== 'draft' && release.status !== 'uploading')
        invalidState('Only a draft or uploading release can be submitted');
      if (
        releaseArtifacts.length !== release.manifest.artifacts.length ||
        releaseArtifacts.some((candidate) => candidate.status !== 'uploaded')
      )
        invalidState('Every declared artifact must be uploaded and finalized before submission');
      const [updated] = await transaction
        .update(releases)
        .set({ status: 'validating' })
        .where(eq(releases.id, id))
        .returning();
      return { release: mapRelease(updated!), artifacts: releaseArtifacts.map(mapArtifact), reviews: [] };
    });
  }

  async applyValidationResult(input: {
    releaseId: string;
    success: boolean;
    artifactIds: string[];
    releaseEvidence: import('@awesome-workflow/contracts').ValidationEvidence[];
    artifactEvidence: Record<string, import('@awesome-workflow/contracts').ValidationEvidence[]>;
  }): Promise<ReleaseStatusView> {
    return this.database.transaction(async (transaction) => {
      const release =
        (
          await transaction
            .select()
            .from(releases)
            .where(eq(releases.id, input.releaseId))
            .for('update')
            .limit(1)
        )[0] ?? notFound('Release');
      const releaseArtifacts = await transaction
        .select()
        .from(artifacts)
        .where(eq(artifacts.releaseId, release.id));
      if (
        releaseArtifacts.length !== input.artifactIds.length ||
        releaseArtifacts.some((candidate) => !input.artifactIds.includes(candidate.id))
      )
        invalidState('Validation result artifacts do not match the immutable release');
      if (release.status !== 'validating') {
        const alreadyApplied = input.success
          ? (release.status === 'ready' || release.status === 'approved') &&
            releaseArtifacts.every((artifact) => artifact.status === 'validated')
          : release.status === 'rejected' &&
            releaseArtifacts.every((artifact) => artifact.status === 'rejected');
        if (alreadyApplied) {
          const reviewRows = await transaction
            .select()
            .from(releaseReviews)
            .where(eq(releaseReviews.releaseId, release.id));
          return {
            release: mapRelease(release),
            artifacts: releaseArtifacts.map(mapArtifact),
            reviews: reviewRows.map(mapReview),
          };
        }
        invalidState('Validation results are accepted only for validating releases');
      }
      for (const artifact of releaseArtifacts) {
        await transaction
          .update(artifacts)
          .set({
            status: input.success ? 'validated' : 'rejected',
            validationEvidence: input.artifactEvidence[artifact.id] ?? [],
          })
          .where(eq(artifacts.id, artifact.id));
      }
      const [updated] = await transaction
        .update(releases)
        .set({ status: input.success ? 'ready' : 'rejected', validationEvidence: input.releaseEvidence })
        .where(eq(releases.id, release.id))
        .returning();
      return {
        release: mapRelease(updated!),
        artifacts: releaseArtifacts.map((artifact) =>
          mapArtifact({
            ...artifact,
            status: input.success ? 'validated' : 'rejected',
            validationEvidence: input.artifactEvidence[artifact.id] ?? [],
          }),
        ),
        reviews: [],
      };
    });
  }

  async createReview(input: {
    releaseId: string;
    reviewerId: string;
    decision: 'approve' | 'reject';
    comment: string;
  }): Promise<ReleaseStatusView> {
    return this.database.transaction(async (transaction) => {
      const release =
        (
          await transaction
            .select()
            .from(releases)
            .where(eq(releases.id, input.releaseId))
            .for('update')
            .limit(1)
        )[0] ?? notFound('Release');
      if (release.status !== 'ready') invalidState('Only a ready release can be reviewed');
      const application =
        (
          await transaction
            .select()
            .from(applications)
            .where(eq(applications.id, release.applicationId))
            .limit(1)
        )[0] ?? notFound('Application');
      const [review] = await transaction
        .insert(releaseReviews)
        .values({ id: randomUUID(), ...input })
        .returning();
      const [updated] = await transaction
        .update(releases)
        .set({ status: input.decision === 'approve' ? 'approved' : 'rejected' })
        .where(eq(releases.id, release.id))
        .returning();
      const releaseArtifacts = await transaction
        .select()
        .from(artifacts)
        .where(eq(artifacts.releaseId, release.id));
      if (!review) throw new Error('Failed to create release review');
      await transaction
        .insert(auditEvents)
        .values(
          newAuditEvent(
            application.workspaceId,
            { type: 'user', id: input.reviewerId },
            'release.reviewed',
            'release',
            release.id,
            { decision: input.decision, reviewId: review.id },
            review.createdAt,
          ),
        );
      return {
        release: mapRelease(updated!),
        artifacts: releaseArtifacts.map(mapArtifact),
        reviews: [mapReview(review)],
      };
    });
  }

  async getReleaseStatus(id: string): Promise<ReleaseStatusView> {
    const release =
      (await this.database.select().from(releases).where(eq(releases.id, id)).limit(1))[0] ??
      notFound('Release');
    const [artifactRows, reviewRows] = await Promise.all([
      this.database.select().from(artifacts).where(eq(artifacts.releaseId, id)),
      this.database.select().from(releaseReviews).where(eq(releaseReviews.releaseId, id)),
    ]);
    return {
      release: mapRelease(release),
      artifacts: artifactRows.map(mapArtifact),
      reviews: reviewRows.map(mapReview),
    };
  }

  async promote(input: {
    applicationId: string;
    releaseId: string;
    channel: ReleaseChannelName;
    promotedBy: string;
    expectedCurrentReleaseId?: string | null;
  }): Promise<CatalogEntry> {
    return this.database.transaction(async (transaction) => {
      const application =
        (
          await transaction
            .select()
            .from(applications)
            .where(eq(applications.id, input.applicationId))
            .limit(1)
        )[0] ?? notFound('Application');
      const release =
        (await transaction.select().from(releases).where(eq(releases.id, input.releaseId)).limit(1))[0] ??
        notFound('Release');
      if (release.applicationId !== application.id || release.status !== 'approved')
        invalidState('Only an approved release belonging to this application can be promoted');
      const current = (
        await transaction
          .select()
          .from(channels)
          .where(and(eq(channels.applicationId, application.id), eq(channels.name, input.channel)))
          .for('update')
          .limit(1)
      )[0];
      if (
        input.expectedCurrentReleaseId !== undefined &&
        (current?.releaseId ?? null) !== input.expectedCurrentReleaseId
      )
        conflict('channel_changed', 'The channel changed since it was read');
      const now = new Date();
      await transaction
        .insert(channels)
        .values({
          applicationId: application.id,
          name: input.channel,
          releaseId: release.id,
          promotedBy: input.promotedBy,
          promotedAt: now,
        })
        .onConflictDoUpdate({
          target: [channels.applicationId, channels.name],
          set: { releaseId: release.id, promotedBy: input.promotedBy, promotedAt: now },
        });
      await transaction.insert(auditEvents).values(
        newAuditEvent(
          application.workspaceId,
          { type: 'user', id: input.promotedBy },
          'channel.promoted',
          'application',
          application.id,
          {
            channel: input.channel,
            previousReleaseId: current?.releaseId ?? null,
            releaseId: release.id,
          },
          now,
        ),
      );
      return mapCatalog(application, release, input.channel, now);
    });
  }

  async listCatalog(input: {
    workspaceId: string;
    channel: ReleaseChannelName;
    kind?: 'web' | 'desktop';
  }): Promise<CatalogEntry[]> {
    const rows = await this.database
      .select({ application: applications, release: releases, channel: channels })
      .from(channels)
      .innerJoin(applications, eq(applications.id, channels.applicationId))
      .innerJoin(releases, eq(releases.id, channels.releaseId))
      .where(
        and(
          eq(applications.workspaceId, input.workspaceId),
          eq(channels.name, input.channel),
          ...(input.kind ? [eq(applications.kind, input.kind)] : []),
        ),
      );
    return rows.map((row) =>
      mapCatalog(row.application, row.release, row.channel.name, row.channel.promotedAt),
    );
  }
}

type ChallengeRow = typeof emailChallenges.$inferSelect;
type UserRow = typeof users.$inferSelect;
type ApplicationRow = typeof applications.$inferSelect;
type ReleaseRow = typeof releases.$inferSelect;
type ArtifactRow = typeof artifacts.$inferSelect;
type ReviewRow = typeof releaseReviews.$inferSelect;
type DeviceRow = typeof devices.$inferSelect;
type InstallationRow = typeof installations.$inferSelect;
type PermissionGrantRow = typeof permissionGrants.$inferSelect;
type ScheduleRow = typeof schedules.$inferSelect;
type RunRow = typeof runs.$inferSelect;

const mapChallenge = (row: ChallengeRow): EmailChallengeRecord => ({
  ...row,
  consumedAt: row.consumedAt ?? undefined,
});
const mapUser = (row: UserRow, platformRoles: PlatformRole[]): CurrentUser => ({
  id: row.id,
  email: row.primaryEmail,
  displayName: row.displayName,
  platformRoles,
});
const mapApplication = (row: ApplicationRow): Application => ({
  id: row.id,
  workspaceId: row.workspaceId,
  slug: row.slug,
  name: row.name,
  summary: row.summary,
  defaultLocale: row.defaultLocale,
  localizations: row.localizations,
  kind: row.kind,
  createdAt: row.createdAt.toISOString(),
});
const mapRelease = (row: ReleaseRow): Release => ({
  id: row.id,
  applicationId: row.applicationId,
  version: row.version,
  manifest: row.manifest,
  manifestSha256: row.manifestSha256,
  signature: row.signature,
  sbom: row.sbom,
  validationEvidence: row.validationEvidence,
  status: row.status,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});
const mapArtifact = (row: ArtifactRow): Artifact => ({
  id: row.id,
  releaseId: row.releaseId,
  fileName: row.fileName,
  contentType: row.contentType,
  size: row.size,
  sha256: row.sha256,
  signature: row.signature,
  sbom: row.sbom,
  storageKey: row.storageKey,
  sbomStorageKey: row.sbomStorageKey,
  status: row.status,
  validationEvidence: row.validationEvidence,
  createdAt: row.createdAt.toISOString(),
  ...(row.finalizedAt ? { finalizedAt: row.finalizedAt.toISOString() } : {}),
});
const mapReview = (row: ReviewRow): ReleaseReview => ({
  id: row.id,
  releaseId: row.releaseId,
  reviewerId: row.reviewerId,
  decision: row.decision,
  comment: row.comment,
  createdAt: row.createdAt.toISOString(),
});
const mapCatalog = (
  application: ApplicationRow,
  release: ReleaseRow,
  channel: ReleaseChannelName,
  promotedAt: Date,
): CatalogEntry => ({
  applicationId: application.id,
  workspaceId: application.workspaceId,
  slug: application.slug,
  name: application.name,
  summary: application.summary,
  defaultLocale: application.defaultLocale,
  localizations: application.localizations,
  kind: application.kind,
  releaseId: release.id,
  version: release.version,
  channel,
  manifest: release.manifest,
  promotedAt: promotedAt.toISOString(),
});
const mapDevice = (row: DeviceRow): Device => {
  if (row.os !== 'windows' && row.os !== 'macos' && row.os !== 'linux') {
    throw new Error(`Unsupported desktop device OS stored in PostgreSQL: ${row.os}`);
  }
  if (row.arch !== 'x64' && row.arch !== 'arm64') {
    throw new Error(`Unsupported desktop device architecture stored in PostgreSQL: ${row.arch}`);
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerId: row.ownerId,
    name: row.name,
    os: row.os,
    arch: row.arch,
    agentVersion: row.agentVersion,
    publicKeyThumbprint: row.publicKeyThumbprint,
    status: row.status,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
};
const mapInstallation = (row: InstallationRow, workspaceId: string): Installation => ({
  id: row.id,
  workspaceId,
  deviceId: row.deviceId,
  applicationId: row.applicationId,
  releaseId: row.releaseId,
  status: row.status,
  errorCode: row.errorCode,
  installedAt: row.installedAt?.toISOString() ?? null,
  updatedAt: row.updatedAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
});
const mapPermissionGrant = (row: PermissionGrantRow, now: Date): PermissionGrant => ({
  id: row.id,
  workspaceId: row.workspaceId,
  deviceId: row.deviceId,
  applicationId: row.applicationId,
  releaseId: row.releaseId,
  capabilities: row.capabilities,
  capabilityHash: row.capabilityHash,
  status: row.status === 'active' && row.expiresAt && row.expiresAt <= now ? 'expired' : row.status,
  grantedBy: row.grantedBy,
  revokedAt: row.revokedAt?.toISOString() ?? null,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});
const mapSchedule = (row: ScheduleRow): Schedule => ({
  id: row.id,
  workspaceId: row.workspaceId,
  applicationId: row.applicationId,
  releaseId: row.releaseId,
  targetDeviceId: row.targetDeviceId,
  name: row.name,
  cronExpression: row.cronExpression,
  timezone: row.timezone,
  nextRunAtMs: row.nextRunAtMs,
  input: { args: [...row.args] },
  status: row.status,
  revision: row.revision,
  createdBy: row.createdBy,
  updatedAt: row.updatedAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
});
const mapScheduleRecord = (row: ScheduleRow, appId: string, version: string): ScheduleRecordIntent => ({
  scheduleId: row.id,
  revision: row.revision,
  applicationId: row.applicationId,
  releaseId: row.releaseId,
  appId,
  version,
  cronExpression: row.cronExpression,
  timezone: row.timezone,
  nextRunAtMs: row.nextRunAtMs,
  args: [...row.args],
  enabled: row.status === 'active',
});
const mapRun = (row: RunRow): Run => ({
  id: row.id,
  workspaceId: row.workspaceId,
  scheduleId: row.scheduleId,
  installationId: row.installationId,
  deviceId: row.deviceId,
  applicationId: row.applicationId,
  releaseId: row.releaseId,
  trigger: row.trigger,
  status: row.status,
  attempt: row.attempt,
  input: mapExecutionInput(row.input),
  result: row.result,
  requiresElevation: row.requiresElevation,
  errorCode: row.errorCode,
  cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
  triggeredBy: row.triggeredBy,
  queuedAt: row.queuedAt.toISOString(),
  startedAt: row.startedAt?.toISOString() ?? null,
  finishedAt: row.finishedAt?.toISOString() ?? null,
});

function sameRunReport(run: Run, input: ReportRunStatusInput): boolean {
  const resultMatches =
    input.result === undefined ? run.result === null : isDeepStrictEqual(run.result, input.result);
  return resultMatches && run.errorCode === (input.errorCode ?? null);
}

function mapExecutionInput(input: Record<string, unknown>): { args: string[] } {
  const args = input.args;
  if (!Array.isArray(args) || !args.every((value): value is string => typeof value === 'string')) {
    throw new Error('Desktop execution input stored in PostgreSQL is invalid');
  }
  return { args: [...args] };
}

function countByRelease(rows: Array<{ releaseId: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { releaseId } of rows) counts.set(releaseId, (counts.get(releaseId) ?? 0) + 1);
  return counts;
}

function assertDesktopRelease(application: ApplicationRow, release: ReleaseRow, workspaceId: string): void {
  if (
    application.workspaceId !== workspaceId ||
    application.kind !== 'desktop' ||
    release.applicationId !== application.id ||
    release.status !== 'approved' ||
    release.manifest.kind !== 'desktop'
  )
    invalidState('Only an approved desktop release belonging to the workspace can be used');
}

function desktopCapabilities(release: ReleaseRow): DesktopCapability[] {
  return (
    optionalDesktopCapabilities(release) ??
    invalidState('A desktop permission grant requires a desktop release')
  );
}

function optionalDesktopCapabilities(release: ReleaseRow): DesktopCapability[] | undefined {
  const manifest = DesktopReleaseManifestSchema.safeParse(release.manifest);
  return manifest.success ? manifest.data.capabilities : undefined;
}

function permissionGrantKey(releaseId: string, capabilityHash: string): string {
  return `${releaseId}:${capabilityHash}`;
}

function permissionGrantIsActiveAt(grant: PermissionGrantRow, now: Date): boolean {
  return grant.status === 'active' && (!grant.expiresAt || grant.expiresAt > now);
}

const permissionApprovalRequired = (): never => {
  throw new DomainError(
    409,
    'permission_approval_required',
    'The device owner must approve this release capability set before it can execute',
  );
};

type AuditActor = { type: 'user' | 'device'; id: string };

function newAuditEvent(
  workspaceId: string,
  actor: AuditActor,
  action: string,
  subjectType: string,
  subjectId: string,
  metadata: Record<string, unknown>,
  createdAt: Date,
): typeof auditEvents.$inferInsert {
  return {
    id: randomUUID(),
    workspaceId,
    actorId: actor.type === 'user' ? actor.id : null,
    actorDeviceId: actor.type === 'device' ? actor.id : null,
    action,
    subjectType,
    subjectId,
    metadata,
    createdAt,
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
