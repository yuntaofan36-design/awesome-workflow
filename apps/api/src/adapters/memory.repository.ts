import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { Injectable } from '@nestjs/common';
import {
  computeDesktopCapabilityHash,
  DesktopReleaseManifestSchema,
  type DesktopReleaseManifest,
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
  InstallationStatus,
  InstallationSyncQuery,
  ListDevicesQuery,
  ListInstallationsQuery,
  ListPermissionGrantsQuery,
  ListReleasesQuery,
  ListRunsQuery,
  ListSchedulesQuery,
  PauseScheduleInput,
  PermissionGrant,
  RegisterDeviceInput,
  ReportRunStatusInput,
  Release,
  ReleaseChannelName,
  ReleaseListItem,
  ReleaseReview,
  ReleaseStatusView,
  RequestInstallationInput,
  Run,
  RunCancellation,
  RunClaim,
  Schedule,
  ScheduleRecord,
  ScheduleSyncQuery,
  ScheduleSyncResult,
  UpdateScheduleInput,
  Workspace,
  WorkspaceRole,
} from '@awesome-workflow/contracts';

import { conflict, DomainError, invalidState, notFound } from '../core/errors.js';
import type {
  ApplicationInput,
  AuditEventRecord,
  ArtifactInput,
  CliAuthorizationRecord,
  EmailChallengeRecord,
  IdentityInput,
  InstallationSyncIndex,
  OidcTransactionRecord,
  ApprovePermissionGrantRecordInput,
  PermissionGrantRequirementInput,
  PlatformRepository,
  RefreshSessionInput,
  ReleaseInput,
  RotateRefreshSessionInput,
  RotateRefreshSessionResult,
} from '../core/repository.js';

type WorkspaceRecord = Omit<Workspace, 'role'> & { createdBy: string };
type MembershipRecord = { workspaceId: string; userId: string; role: WorkspaceRole };
type StoredDevice = Device & { credentialHash: string; installationRevision: number };
type ChannelRecord = {
  applicationId: string;
  name: ReleaseChannelName;
  releaseId: string;
  promotedBy: string;
  promotedAt: string;
};
type ScheduleChangeRecord = {
  workspaceId: string;
  revision: number;
  scheduleId: string;
  targetDeviceId: string | null;
  operation: 'upsert' | 'remove';
  record?: ScheduleRecord;
};

@Injectable()
export class MemoryPlatformRepository implements PlatformRepository {
  private challenges: EmailChallengeRecord[] = [];
  private oidcTransactions: OidcTransactionRecord[] = [];
  private cliAuthorizations: Array<
    CliAuthorizationRecord & {
      userId?: string;
      codeHash?: string;
      authorizedAt?: Date;
      consumedAt?: Date;
    }
  > = [];
  private users: CurrentUser[] = [];
  private identities: Array<IdentityInput & { userId: string }> = [];
  private sessions: Array<{
    tokenHash: string;
    userId: string;
    expiresAt: Date;
    refreshFamilyId?: string;
    revokedAt?: Date;
  }> = [];
  private refreshTokens: Array<{
    familyId: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    consumedAt?: Date;
    revokedAt?: Date;
    createdAt: Date;
  }> = [];
  private workspaces: WorkspaceRecord[] = [];
  private memberships: MembershipRecord[] = [];
  private applications: Application[] = [];
  private releases: Release[] = [];
  private artifacts: Artifact[] = [];
  private reviews: ReleaseReview[] = [];
  private channels: ChannelRecord[] = [];
  private devices: StoredDevice[] = [];
  private installations: Installation[] = [];
  private permissionGrants: PermissionGrant[] = [];
  private schedules: Schedule[] = [];
  private scheduleWorkspaceRevisions = new Map<string, number>();
  private scheduleChanges: ScheduleChangeRecord[] = [];
  private runs: Run[] = [];
  private auditEvents: AuditEventRecord[] = [];
  private writeQueue = Promise.resolve();

  async findLatestEmailChallenge(email: string): Promise<EmailChallengeRecord | null> {
    const record = this.challenges
      .filter((candidate) => candidate.email === email && !candidate.consumedAt)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return record ? structuredClone(record) : null;
  }

  async findEmailChallengeById(id: string): Promise<EmailChallengeRecord | null> {
    const record = this.challenges.find((candidate) => candidate.id === id);
    return record ? structuredClone(record) : null;
  }

  async createEmailChallenge(record: EmailChallengeRecord): Promise<void> {
    await this.write(() => this.challenges.push(structuredClone(record)));
  }

  async consumeEmailChallenge(
    id: string,
    suppliedHash: string,
    now: Date,
    maxAttempts: number,
  ): Promise<string> {
    return this.write(() => {
      const record = this.challenges.find((candidate) => candidate.id === id);
      if (!record)
        throw new DomainError(409, 'invalid_state', 'The email challenge is invalid or already consumed');
      if (record.consumedAt) invalidState('The email challenge is invalid or already consumed');
      if (record.expiresAt <= now) invalidState('The email challenge has expired');
      if (record.attempts >= maxAttempts)
        throw new DomainError(
          429,
          'challenge_attempts_exhausted',
          'The email challenge has too many failed attempts',
        );
      record.attempts += 1;
      if (!constantTimeEqual(record.codeHash, suppliedHash)) invalidState('The verification code is invalid');
      record.consumedAt = now;
      return record.email;
    });
  }

  async createOidcTransaction(record: OidcTransactionRecord): Promise<void> {
    await this.write(() => this.oidcTransactions.push(structuredClone(record)));
  }

  async consumeOidcTransaction(stateHash: string, now: Date): Promise<OidcTransactionRecord> {
    return this.write(() => {
      const record = this.oidcTransactions.find((candidate) => candidate.stateHash === stateHash);
      if (!record)
        throw new DomainError(
          409,
          'invalid_state',
          'The OIDC authorization transaction is invalid or expired',
        );
      if (record.consumedAt || record.expiresAt <= now)
        invalidState('The OIDC authorization transaction is invalid or expired');
      record.consumedAt = now;
      return structuredClone(record);
    });
  }

  async createCliAuthorization(record: CliAuthorizationRecord): Promise<void> {
    await this.write(() => this.cliAuthorizations.push(structuredClone(record)));
  }

  async authorizeCliRequest(
    id: string,
    userId: string,
    codeHash: string,
    now: Date,
  ): Promise<{ redirectUri: string; state: string }> {
    return this.write(() => {
      const record =
        this.cliAuthorizations.find((candidate) => candidate.id === id) ?? notFound('CLI authorization');
      if (record.expiresAt <= now || record.authorizedAt || record.consumedAt)
        invalidState('The CLI authorization request is invalid or expired');
      record.userId = userId;
      record.codeHash = codeHash;
      record.authorizedAt = now;
      return { redirectUri: record.redirectUri, state: record.state };
    });
  }

  async consumeCliAuthorization(input: {
    codeHash: string;
    redirectUri: string;
    codeChallenge: string;
    now: Date;
  }): Promise<{ user: CurrentUser; offlineAccess: boolean }> {
    return this.write(() => {
      const record = this.cliAuthorizations.find((candidate) => candidate.codeHash === input.codeHash);
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
      record.consumedAt = input.now;
      return {
        user: structuredClone(this.users.find((candidate) => candidate.id === userId) ?? notFound('User')),
        offlineAccess: record.offlineAccess,
      };
    });
  }

  async upsertIdentity(input: IdentityInput): Promise<CurrentUser> {
    return this.write(() => {
      const existingIdentity = this.identities.find(
        (candidate) => candidate.issuer === input.issuer && candidate.subject === input.subject,
      );
      let user = existingIdentity
        ? this.users.find((candidate) => candidate.id === existingIdentity.userId)
        : undefined;
      if (!user) {
        user = {
          id: randomUUID(),
          email: input.email,
          displayName: input.displayName,
          platformRoles: [...input.platformRoles],
        };
        this.users.push(user);
        const workspaceId = randomUUID();
        const slugBase =
          input.email
            .split('@')[0]
            ?.replace(/[^a-z0-9-]/g, '-')
            .replace(/^-+|-+$/g, '') || 'personal';
        this.workspaces.push({
          id: workspaceId,
          slug: `${slugBase.slice(0, 48)}-${workspaceId.slice(0, 8)}`,
          name: `${input.displayName}'s workspace`,
          createdBy: user.id,
          createdAt: new Date().toISOString(),
        });
        this.memberships.push({ workspaceId, userId: user.id, role: 'owner' });
      }
      if (!existingIdentity) this.identities.push({ ...input, userId: user.id });
      return structuredClone(user);
    });
  }

  async createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.write(() => this.sessions.push({ tokenHash, userId, expiresAt }));
  }

  async createRefreshSession(input: RefreshSessionInput): Promise<void> {
    await this.write(() => {
      this.refreshTokens.push({
        familyId: input.familyId,
        userId: input.userId,
        tokenHash: input.refreshTokenHash,
        expiresAt: input.refreshExpiresAt,
        createdAt: input.now,
      });
      this.sessions.push({
        tokenHash: input.accessTokenHash,
        userId: input.userId,
        expiresAt: input.accessExpiresAt,
        refreshFamilyId: input.familyId,
      });
    });
  }

  async rotateRefreshSession(input: RotateRefreshSessionInput): Promise<RotateRefreshSessionResult> {
    return this.write(() => {
      const refresh = this.refreshTokens.find((candidate) => candidate.tokenHash === input.refreshTokenHash);
      if (!refresh) return { status: 'invalid' };
      const replayed = refresh.consumedAt !== undefined;
      if (refresh.consumedAt || refresh.revokedAt || refresh.expiresAt <= input.now) {
        this.revokeRefreshFamily(refresh.familyId, input.now);
        return { status: replayed ? 'replayed' : 'invalid' };
      }
      refresh.consumedAt = input.now;
      for (const session of this.sessions) {
        if (session.refreshFamilyId === refresh.familyId && !session.revokedAt) {
          session.revokedAt = input.now;
        }
      }
      this.refreshTokens.push({
        familyId: refresh.familyId,
        userId: refresh.userId,
        tokenHash: input.nextRefreshTokenHash,
        expiresAt: refresh.expiresAt,
        createdAt: input.now,
      });
      this.sessions.push({
        tokenHash: input.nextAccessTokenHash,
        userId: refresh.userId,
        expiresAt: input.nextAccessExpiresAt,
        refreshFamilyId: refresh.familyId,
      });
      const user = this.users.find((candidate) => candidate.id === refresh.userId) ?? notFound('User');
      return { status: 'rotated', user: structuredClone(user) };
    });
  }

  async findUserBySession(tokenHash: string, now: Date): Promise<CurrentUser | null> {
    const session = this.sessions.find(
      (candidate) => candidate.tokenHash === tokenHash && !candidate.revokedAt && candidate.expiresAt > now,
    );
    const user = session ? this.users.find((candidate) => candidate.id === session.userId) : undefined;
    return user ? structuredClone(user) : null;
  }

  async revokeSessionFamily(tokenHash: string, now: Date): Promise<void> {
    await this.write(() => {
      const session = this.sessions.find((candidate) => candidate.tokenHash === tokenHash);
      if (!session) return;
      session.revokedAt = now;
      if (session.refreshFamilyId) this.revokeRefreshFamily(session.refreshFamilyId, now);
    });
  }

  async listWorkspaces(userId: string): Promise<Workspace[]> {
    return this.memberships
      .filter((membership) => membership.userId === userId)
      .map((membership) => {
        const workspace =
          this.workspaces.find((candidate) => candidate.id === membership.workspaceId) ??
          notFound('Workspace');
        return {
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          createdAt: workspace.createdAt,
          role: membership.role,
        };
      });
  }

  async createWorkspace(input: { slug: string; name: string; userId: string }): Promise<Workspace> {
    return this.write(() => {
      if (this.workspaces.some((candidate) => candidate.slug === input.slug))
        conflict('workspace_slug_exists', 'A workspace already uses that slug');
      const workspace: WorkspaceRecord = {
        id: randomUUID(),
        slug: input.slug,
        name: input.name,
        createdBy: input.userId,
        createdAt: new Date().toISOString(),
      };
      this.workspaces.push(workspace);
      this.memberships.push({ workspaceId: workspace.id, userId: input.userId, role: 'owner' });
      return {
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        createdAt: workspace.createdAt,
        role: 'owner',
      };
    });
  }

  async getWorkspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    return (
      this.memberships.find(
        (candidate) => candidate.workspaceId === workspaceId && candidate.userId === userId,
      )?.role ?? null
    );
  }

  async registerDevice(
    input: RegisterDeviceInput & { ownerId: string; credentialHash: string },
  ): Promise<Device> {
    return this.write(() => {
      const existing = this.devices.find(
        (candidate) =>
          candidate.ownerId === input.ownerId && candidate.publicKeyThumbprint === input.publicKeyThumbprint,
      );
      if (
        this.devices.some(
          (candidate) => candidate.credentialHash === input.credentialHash && candidate.id !== existing?.id,
        )
      ) {
        conflict('device_credential_exists', 'That device credential is already registered');
      }
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
        existing.name = input.name;
        existing.agentVersion = input.agentVersion;
        existing.credentialHash = input.credentialHash;
        this.audit(input.workspaceId, input.ownerId, 'device.credential_rotated', 'device', existing.id);
        return publicDevice(existing);
      }
      const now = new Date().toISOString();
      const device: StoredDevice = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        ownerId: input.ownerId,
        name: input.name,
        os: input.os,
        arch: input.arch,
        agentVersion: input.agentVersion,
        publicKeyThumbprint: input.publicKeyThumbprint,
        credentialHash: input.credentialHash,
        installationRevision: 0,
        status: 'active',
        lastSeenAt: null,
        createdAt: now,
      };
      this.devices.push(device);
      this.audit(input.workspaceId, input.ownerId, 'device.registered', 'device', device.id, {
        os: device.os,
        arch: device.arch,
      });
      return publicDevice(device);
    });
  }

  async findActiveDeviceByCredentialHash(credentialHash: string): Promise<Device | null> {
    const device = this.devices.find(
      (candidate) => candidate.credentialHash === credentialHash && candidate.status === 'active',
    );
    return device ? publicDevice(device) : null;
  }

  async getDevice(id: string): Promise<Device> {
    return publicDevice(this.devices.find((candidate) => candidate.id === id) ?? notFound('Device'));
  }

  async listDevices(input: ListDevicesQuery): Promise<Device[]> {
    return this.devices
      .filter(
        (candidate) =>
          candidate.workspaceId === input.workspaceId && (!input.status || candidate.status === input.status),
      )
      .map(publicDevice);
  }

  async revokeDevice(id: string, actorId: string): Promise<Device> {
    return this.write(() => {
      const device = this.devices.find((candidate) => candidate.id === id) ?? notFound('Device');
      if (device.status === 'revoked') return publicDevice(device);
      device.status = 'revoked';
      this.audit(device.workspaceId, actorId, 'device.revoked', 'device', device.id);
      return publicDevice(device);
    });
  }

  async requestInstallation(
    input: RequestInstallationInput & { requestedBy: string },
  ): Promise<Installation> {
    return this.write(async () => {
      const device = this.activeDevice(input.deviceId);
      if (device.workspaceId !== input.workspaceId)
        invalidState('The device does not belong to the requested workspace');
      const { application } = this.desktopRelease(input.applicationId, input.releaseId, input.workspaceId);
      await this.requireActivePermissionGrant({
        deviceId: device.id,
        releaseId: input.releaseId,
        now: new Date(),
      });
      const existing = this.installations.find(
        (candidate) =>
          candidate.deviceId === input.deviceId &&
          candidate.applicationId === input.applicationId &&
          candidate.releaseId === input.releaseId,
      );
      if (existing && !['failed', 'removed'].includes(existing.status)) return structuredClone(existing);
      const now = new Date().toISOString();
      const installation: Installation = existing ?? {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        deviceId: device.id,
        applicationId: application.id,
        releaseId: input.releaseId,
        status: 'requested',
        errorCode: null,
        installedAt: null,
        updatedAt: now,
        createdAt: now,
      };
      if (existing) {
        existing.status = 'requested';
        existing.errorCode = null;
        existing.installedAt = null;
        existing.updatedAt = now;
      } else {
        this.installations.push(installation);
      }
      device.installationRevision += 1;
      this.audit(
        input.workspaceId,
        input.requestedBy,
        'installation.requested',
        'installation',
        installation.id,
        {
          deviceId: device.id,
          releaseId: input.releaseId,
        },
      );
      return structuredClone(installation);
    });
  }

  async getInstallation(id: string): Promise<Installation> {
    return structuredClone(
      this.installations.find((candidate) => candidate.id === id) ?? notFound('Installation'),
    );
  }

  async listInstallations(input: ListInstallationsQuery): Promise<Installation[]> {
    return structuredClone(
      this.installations.filter(
        (candidate) =>
          candidate.workspaceId === input.workspaceId &&
          (!input.deviceId || candidate.deviceId === input.deviceId) &&
          (!input.status || candidate.status === input.status),
      ),
    );
  }

  async syncInstallations(deviceId: string, input: InstallationSyncQuery): Promise<InstallationSyncIndex> {
    const device = this.activeDevice(deviceId);
    if (input.revision !== undefined && input.revision > device.installationRevision) {
      conflict('installation_revision_ahead', 'The supplied installation revision is ahead of the server');
    }
    if (input.revision === device.installationRevision) {
      return { revision: device.installationRevision, changed: false, installations: [] };
    }
    const authorized: Installation[] = [];
    for (const installation of this.installations.filter(
      (candidate) => candidate.deviceId === device.id && !['failed', 'removed'].includes(candidate.status),
    )) {
      try {
        await this.requireActivePermissionGrant({
          deviceId: device.id,
          releaseId: installation.releaseId,
          now: new Date(),
        });
        authorized.push(installation);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'permission_approval_required')) throw error;
      }
    }
    return {
      revision: device.installationRevision,
      changed: true,
      installations: structuredClone(authorized),
    };
  }

  async updateInstallationStatus(input: {
    id: string;
    deviceId: string;
    status: InstallationStatus;
    errorCode?: string;
  }): Promise<Installation> {
    return this.write(async () => {
      const installation =
        this.installations.find((candidate) => candidate.id === input.id) ?? notFound('Installation');
      const device = this.activeDevice(input.deviceId);
      if (installation.deviceId !== device.id)
        invalidState('The installation is not assigned to this device');
      const allowed: Record<InstallationStatus, InstallationStatus[]> = {
        requested: ['downloading', 'failed'],
        downloading: ['installed', 'failed'],
        installed: ['removed'],
        failed: [],
        removed: [],
      };
      if (installation.status === input.status) return structuredClone(installation);
      if (!allowed[installation.status].includes(input.status))
        invalidState(`Installation cannot transition from ${installation.status} to ${input.status}`);
      if (input.status === 'installed') {
        await this.requireActivePermissionGrant({
          deviceId: device.id,
          releaseId: installation.releaseId,
          now: new Date(),
        });
      }
      const now = new Date().toISOString();
      installation.status = input.status;
      installation.errorCode = input.errorCode ?? null;
      installation.updatedAt = now;
      if (input.status === 'installed') installation.installedAt = now;
      this.audit(
        installation.workspaceId,
        device.id,
        'installation.status_changed',
        'installation',
        installation.id,
        {
          status: input.status,
        },
        'device',
      );
      return structuredClone(installation);
    });
  }

  async approvePermissionGrant(input: ApprovePermissionGrantRecordInput): Promise<PermissionGrant> {
    return this.write(async () => {
      const device = this.activeDevice(input.deviceId);
      const release =
        this.releases.find((candidate) => candidate.id === input.releaseId) ?? notFound('Release');
      const application =
        this.applications.find((candidate) => candidate.id === release.applicationId) ??
        notFound('Application');
      const { manifest } = this.desktopRelease(application.id, release.id, device.workspaceId);
      const capabilityHash = await computeDesktopCapabilityHash(manifest.capabilities);
      if (capabilityHash !== input.expectedCapabilityHash) {
        conflict('permission_requirement_changed', 'The requested capability set changed before approval');
      }
      if (input.expiresAt && input.expiresAt <= input.now) {
        invalidState('Permission grant expiry must be in the future');
      }
      const now = input.now.toISOString();
      const existing = this.permissionGrants.find(
        (candidate) =>
          candidate.deviceId === input.deviceId &&
          candidate.releaseId === input.releaseId &&
          candidate.capabilityHash === capabilityHash,
      );
      if (existing) {
        existing.status = 'active';
        existing.grantedBy = input.grantedBy;
        existing.revokedAt = null;
        existing.expiresAt = input.expiresAt?.toISOString() ?? null;
        this.audit(
          existing.workspaceId,
          input.grantedBy,
          'permission_grant.approved',
          'permission_grant',
          existing.id,
          { capabilityHash: existing.capabilityHash, releaseId: existing.releaseId },
        );
        return structuredClone(existing);
      }
      const grant: PermissionGrant = {
        id: randomUUID(),
        workspaceId: device.workspaceId,
        deviceId: input.deviceId,
        applicationId: application.id,
        releaseId: input.releaseId,
        capabilities: structuredClone(manifest.capabilities),
        capabilityHash,
        status: 'active',
        grantedBy: input.grantedBy,
        revokedAt: null,
        expiresAt: input.expiresAt?.toISOString() ?? null,
        createdAt: now,
      };
      this.permissionGrants.push(grant);
      this.audit(
        grant.workspaceId,
        input.grantedBy,
        'permission_grant.approved',
        'permission_grant',
        grant.id,
        { capabilityHash: grant.capabilityHash, releaseId: grant.releaseId },
      );
      return structuredClone(grant);
    });
  }

  async getPermissionGrant(id: string): Promise<PermissionGrant> {
    const grant =
      this.permissionGrants.find((candidate) => candidate.id === id) ?? notFound('Permission grant');
    return structuredClone(materializePermissionGrant(grant, new Date()));
  }

  async listPermissionGrants(input: ListPermissionGrantsQuery): Promise<PermissionGrant[]> {
    return structuredClone(
      this.permissionGrants
        .map((grant) => materializePermissionGrant(grant, new Date()))
        .filter(
          (candidate) =>
            candidate.workspaceId === input.workspaceId &&
            (!input.deviceId || candidate.deviceId === input.deviceId) &&
            (!input.applicationId || candidate.applicationId === input.applicationId) &&
            (!input.status || candidate.status === input.status),
        ),
    );
  }

  async revokePermissionGrant(id: string, actorId: string): Promise<PermissionGrant> {
    return this.write(() => {
      const grant =
        this.permissionGrants.find((candidate) => candidate.id === id) ?? notFound('Permission grant');
      if (grant.status === 'revoked') return structuredClone(grant);
      const now = new Date().toISOString();
      grant.status = 'revoked';
      grant.revokedAt = now;

      for (const schedule of this.schedules.filter(
        (candidate) =>
          candidate.targetDeviceId === grant.deviceId &&
          candidate.releaseId === grant.releaseId &&
          candidate.status !== 'disabled',
      )) {
        const revision = this.nextScheduleRevision(schedule.workspaceId);
        schedule.status = 'disabled';
        schedule.revision = revision;
        schedule.updatedAt = now;
        this.scheduleChanges.push({
          workspaceId: schedule.workspaceId,
          revision,
          scheduleId: schedule.id,
          targetDeviceId: schedule.targetDeviceId,
          operation: 'remove',
        });
        this.audit(schedule.workspaceId, actorId, 'schedule.permission_revoked', 'schedule', schedule.id, {
          grantId: grant.id,
          revision,
        });
      }

      for (const run of this.runs.filter(
        (candidate) =>
          candidate.deviceId === grant.deviceId &&
          candidate.releaseId === grant.releaseId &&
          candidate.status === 'queued',
      )) {
        run.status = 'failed';
        run.errorCode = 'permission_grant_inactive';
        run.finishedAt = now;
        this.audit(run.workspaceId, actorId, 'run.permission_revoked', 'run', run.id, {
          grantId: grant.id,
        });
      }
      this.audit(grant.workspaceId, actorId, 'permission_grant.revoked', 'permission_grant', grant.id, {
        capabilityHash: grant.capabilityHash,
        releaseId: grant.releaseId,
      });
      return structuredClone(grant);
    });
  }

  async requireActivePermissionGrant(input: PermissionGrantRequirementInput): Promise<PermissionGrant> {
    const device = this.activeDevice(input.deviceId);
    const release =
      this.releases.find((candidate) => candidate.id === input.releaseId) ?? notFound('Release');
    const application =
      this.applications.find((candidate) => candidate.id === release.applicationId) ??
      notFound('Application');
    const { manifest } = this.desktopRelease(application.id, release.id, device.workspaceId);
    const capabilityHash = await computeDesktopCapabilityHash(manifest.capabilities);
    const grant = this.permissionGrants.find(
      (candidate) =>
        candidate.deviceId === device.id &&
        candidate.releaseId === release.id &&
        candidate.capabilityHash === capabilityHash &&
        candidate.status === 'active' &&
        (!candidate.expiresAt || Date.parse(candidate.expiresAt) > input.now.getTime()),
    );
    if (!grant) {
      throw new DomainError(
        409,
        'permission_approval_required',
        'The device owner must approve this release capability set before it can execute',
      );
    }
    return structuredClone(grant);
  }

  async createSchedule(input: CreateScheduleInput & { createdBy: string }): Promise<Schedule> {
    return this.write(async () => {
      const device = this.activeDevice(input.targetDeviceId);
      if (device.workspaceId !== input.workspaceId)
        invalidState('The target device does not belong to the schedule workspace');
      this.desktopRelease(input.applicationId, input.releaseId, input.workspaceId);
      await this.requireActivePermissionGrant({
        deviceId: device.id,
        releaseId: input.releaseId,
        now: new Date(),
      });
      const now = new Date().toISOString();
      const revision = this.nextScheduleRevision(input.workspaceId);
      const schedule: Schedule = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        applicationId: input.applicationId,
        releaseId: input.releaseId,
        targetDeviceId: input.targetDeviceId,
        name: input.name,
        cronExpression: input.cronExpression,
        timezone: input.timezone,
        nextRunAtMs: input.nextRunAtMs,
        input: structuredClone(input.input),
        status: 'active',
        revision,
        createdBy: input.createdBy,
        updatedAt: now,
        createdAt: now,
      };
      this.schedules.push(schedule);
      this.scheduleChanges.push({
        workspaceId: schedule.workspaceId,
        revision,
        scheduleId: schedule.id,
        targetDeviceId: schedule.targetDeviceId,
        operation: 'upsert',
        record: this.scheduleRecord(schedule),
      });
      this.audit(schedule.workspaceId, input.createdBy, 'schedule.created', 'schedule', schedule.id, {
        revision,
      });
      return structuredClone(schedule);
    });
  }

  async getSchedule(id: string): Promise<Schedule> {
    return structuredClone(this.schedules.find((candidate) => candidate.id === id) ?? notFound('Schedule'));
  }

  async listSchedules(input: ListSchedulesQuery): Promise<Schedule[]> {
    return structuredClone(
      this.schedules.filter(
        (candidate) =>
          candidate.workspaceId === input.workspaceId &&
          (!input.targetDeviceId || candidate.targetDeviceId === input.targetDeviceId) &&
          (!input.status || candidate.status === input.status),
      ),
    );
  }

  async updateSchedule(id: string, input: UpdateScheduleInput & { actorId: string }): Promise<Schedule> {
    return this.write(async () => {
      const schedule = this.schedules.find((candidate) => candidate.id === id) ?? notFound('Schedule');
      if (schedule.revision !== input.expectedRevision)
        conflict('schedule_changed', 'The schedule changed since it was read');
      const oldTarget = schedule.targetDeviceId;
      const targetDeviceId = input.targetDeviceId === undefined ? oldTarget : input.targetDeviceId;
      if (targetDeviceId) {
        const device = this.activeDevice(targetDeviceId);
        if (device.workspaceId !== schedule.workspaceId)
          invalidState('The target device does not belong to the schedule workspace');
      }
      const releaseId = input.releaseId ?? schedule.releaseId;
      this.desktopRelease(schedule.applicationId, releaseId, schedule.workspaceId);
      const activeTargetDeviceId =
        targetDeviceId ??
        invalidState('Desktop schedules must target a device with an active permission grant');
      await this.requireActivePermissionGrant({ deviceId: activeTargetDeviceId, releaseId, now: new Date() });
      if (input.releaseId !== undefined) schedule.releaseId = input.releaseId;
      if (input.targetDeviceId !== undefined) schedule.targetDeviceId = input.targetDeviceId;
      if (input.name !== undefined) schedule.name = input.name;
      if (input.cronExpression !== undefined) schedule.cronExpression = input.cronExpression;
      if (input.timezone !== undefined) schedule.timezone = input.timezone;
      if (input.nextRunAtMs !== undefined) schedule.nextRunAtMs = input.nextRunAtMs;
      if (input.input !== undefined) schedule.input = structuredClone(input.input);
      const revision = this.nextScheduleRevision(schedule.workspaceId);
      schedule.revision = revision;
      schedule.updatedAt = new Date().toISOString();
      if (oldTarget !== schedule.targetDeviceId) {
        this.scheduleChanges.push({
          workspaceId: schedule.workspaceId,
          revision,
          scheduleId: schedule.id,
          targetDeviceId: oldTarget,
          operation: 'remove',
        });
      }
      this.scheduleChanges.push({
        workspaceId: schedule.workspaceId,
        revision,
        scheduleId: schedule.id,
        targetDeviceId: schedule.targetDeviceId,
        operation: 'upsert',
        record: this.scheduleRecord(schedule),
      });
      this.audit(schedule.workspaceId, input.actorId, 'schedule.updated', 'schedule', schedule.id, {
        revision,
      });
      return structuredClone(schedule);
    });
  }

  async pauseSchedule(id: string, input: PauseScheduleInput & { actorId: string }): Promise<Schedule> {
    return this.write(async () => {
      const schedule = this.schedules.find((candidate) => candidate.id === id) ?? notFound('Schedule');
      if (schedule.revision !== input.expectedRevision)
        conflict('schedule_changed', 'The schedule changed since it was read');
      const nextStatus = input.paused ? 'paused' : 'active';
      if (schedule.status === nextStatus) return structuredClone(schedule);
      if (nextStatus === 'active') {
        const targetDeviceId =
          schedule.targetDeviceId ??
          invalidState('Desktop schedules must target a device with an active permission grant');
        await this.requireActivePermissionGrant({
          deviceId: targetDeviceId,
          releaseId: schedule.releaseId,
          now: new Date(),
        });
      }
      schedule.status = nextStatus;
      const revision = this.nextScheduleRevision(schedule.workspaceId);
      schedule.revision = revision;
      schedule.updatedAt = new Date().toISOString();
      this.scheduleChanges.push({
        workspaceId: schedule.workspaceId,
        revision,
        scheduleId: schedule.id,
        targetDeviceId: schedule.targetDeviceId,
        operation: 'upsert',
        record: this.scheduleRecord(schedule),
      });
      this.audit(
        schedule.workspaceId,
        input.actorId,
        input.paused ? 'schedule.paused' : 'schedule.resumed',
        'schedule',
        schedule.id,
        { revision },
      );
      return structuredClone(schedule);
    });
  }

  async syncSchedules(deviceId: string, input: ScheduleSyncQuery): Promise<ScheduleSyncResult> {
    return this.write(async () => {
      const device = this.activeDevice(deviceId);
      const now = new Date();
      device.lastSeenAt = now.toISOString();

      for (const schedule of this.schedules.filter(
        (candidate) =>
          candidate.workspaceId === device.workspaceId &&
          candidate.targetDeviceId === device.id &&
          candidate.status !== 'disabled',
      )) {
        if (await this.hasActivePermissionGrant(device.id, schedule.releaseId, now)) continue;
        const revision = this.nextScheduleRevision(schedule.workspaceId);
        schedule.status = 'disabled';
        schedule.revision = revision;
        schedule.updatedAt = now.toISOString();
        this.scheduleChanges.push({
          workspaceId: schedule.workspaceId,
          revision,
          scheduleId: schedule.id,
          targetDeviceId: device.id,
          operation: 'remove',
        });
        this.audit(
          schedule.workspaceId,
          device.id,
          'schedule.permission_expired',
          'schedule',
          schedule.id,
          { revision },
          'device',
        );
      }

      const currentRevision = this.scheduleWorkspaceRevisions.get(device.workspaceId) ?? 0;
      if (input.revision === undefined) {
        return {
          kind: 'snapshot',
          snapshot: {
            revision: currentRevision,
            schedules: this.schedules
              .filter(
                (schedule) =>
                  schedule.workspaceId === device.workspaceId &&
                  schedule.status !== 'disabled' &&
                  (schedule.targetDeviceId === null || schedule.targetDeviceId === device.id),
              )
              .map((schedule) => this.scheduleRecord(schedule)),
          },
        };
      }
      if (input.revision > currentRevision)
        conflict('schedule_revision_ahead', 'The supplied schedule revision is ahead of the server');
      const upserts = new Map<string, ScheduleRecord>();
      const removed = new Set<string>();
      for (const change of this.scheduleChanges.filter(
        (candidate) =>
          candidate.workspaceId === device.workspaceId &&
          candidate.revision > input.revision! &&
          (candidate.targetDeviceId === null || candidate.targetDeviceId === device.id),
      )) {
        if (change.operation === 'remove') {
          upserts.delete(change.scheduleId);
          removed.add(change.scheduleId);
        } else if (change.record) {
          removed.delete(change.scheduleId);
          upserts.set(change.scheduleId, structuredClone(change.record));
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
    });
  }

  async createManualRun(input: CreateManualRunInput & { triggeredBy: string }): Promise<Run> {
    return this.write(async () => {
      const device = this.activeDevice(input.deviceId);
      if (device.workspaceId !== input.workspaceId)
        invalidState('The device does not belong to the run workspace');
      const { release } = this.desktopRelease(input.applicationId, input.releaseId, input.workspaceId);
      await this.requireActivePermissionGrant({
        deviceId: device.id,
        releaseId: input.releaseId,
        now: new Date(),
      });
      const installation =
        this.installations.find(
          (candidate) =>
            candidate.deviceId === input.deviceId &&
            candidate.applicationId === input.applicationId &&
            candidate.releaseId === input.releaseId &&
            candidate.status === 'installed',
        ) ??
        invalidState('The approved desktop release must be installed on the target device before it can run');
      const run: Run = {
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
        input: structuredClone(input.input),
        result: null,
        requiresElevation:
          release.manifest.kind === 'desktop' &&
          release.manifest.capabilities.some(
            (capability) => capability.kind === 'lifecycle' && capability.elevation === 'user-approved',
          ),
        errorCode: null,
        cancelRequestedAt: null,
        triggeredBy: input.triggeredBy,
        queuedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      };
      this.runs.push(run);
      this.audit(run.workspaceId, input.triggeredBy, 'run.created', 'run', run.id, {
        deviceId: run.deviceId,
      });
      return structuredClone(run);
    });
  }

  async getRun(id: string): Promise<Run> {
    return structuredClone(this.runs.find((candidate) => candidate.id === id) ?? notFound('Run'));
  }

  async listRuns(input: ListRunsQuery): Promise<Run[]> {
    return structuredClone(
      this.runs.filter(
        (candidate) =>
          candidate.workspaceId === input.workspaceId &&
          (!input.deviceId || candidate.deviceId === input.deviceId) &&
          (!input.scheduleId || candidate.scheduleId === input.scheduleId) &&
          (!input.trigger || candidate.trigger === input.trigger) &&
          (!input.status || candidate.status === input.status),
      ),
    );
  }

  async cancelRun(id: string, actorId: string): Promise<Run> {
    return this.write(() => {
      const run = this.runs.find((candidate) => candidate.id === id) ?? notFound('Run');
      if (run.status === 'cancelled') return structuredClone(run);
      if (run.status === 'succeeded' || run.status === 'failed')
        invalidState('A completed run cannot be cancelled');
      if (run.cancelRequestedAt) return structuredClone(run);
      const now = new Date().toISOString();
      run.cancelRequestedAt = now;
      if (run.status === 'queued') {
        run.status = 'cancelled';
        run.finishedAt = now;
        this.audit(run.workspaceId, actorId, 'run.cancelled', 'run', run.id);
      } else {
        this.audit(run.workspaceId, actorId, 'run.cancel_requested', 'run', run.id, {
          attempt: run.attempt,
        });
      }
      return structuredClone(run);
    });
  }

  async claimRuns(deviceId: string, input: ClaimRunsInput): Promise<RunClaim[]> {
    return this.write(async () => {
      const device = this.activeDevice(deviceId);
      device.lastSeenAt = new Date().toISOString();
      const claimed = this.runs
        .filter((candidate) => candidate.deviceId === device.id && candidate.status === 'queued')
        .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt))
        .slice(0, input.limit);
      const result: RunClaim[] = [];
      for (const run of claimed) {
        try {
          await this.requireActivePermissionGrant({
            deviceId: device.id,
            releaseId: run.releaseId,
            now: new Date(),
          });
        } catch (error) {
          if (error instanceof DomainError && error.code === 'permission_approval_required') {
            run.status = 'failed';
            run.errorCode = 'permission_grant_inactive';
            run.finishedAt = new Date().toISOString();
            this.audit(
              run.workspaceId,
              device.id,
              'run.permission_denied',
              'run',
              run.id,
              { attempt: run.attempt },
              'device',
            );
            continue;
          }
          throw error;
        }
        run.status = 'dispatched';
        const application =
          this.applications.find((candidate) => candidate.id === run.applicationId) ??
          notFound('Application');
        const release =
          this.releases.find((candidate) => candidate.id === run.releaseId) ?? notFound('Release');
        this.audit(
          run.workspaceId,
          device.id,
          'run.claimed',
          'run',
          run.id,
          { attempt: run.attempt },
          'device',
        );
        result.push({
          runId: run.id,
          attempt: run.attempt,
          appId: application.slug,
          version: release.version,
          args: [...run.input.args],
          requiresElevation: run.requiresElevation,
        });
      }
      return result;
    });
  }

  async listRunCancellations(deviceId: string): Promise<RunCancellation[]> {
    return this.write(() => {
      const device = this.activeDevice(deviceId);
      device.lastSeenAt = new Date().toISOString();
      return this.runs
        .filter(
          (run) =>
            run.deviceId === device.id &&
            run.cancelRequestedAt !== null &&
            ['dispatched', 'running', 'needs_user_approval'].includes(run.status),
        )
        .map((run) => ({
          runId: run.id,
          attempt: run.attempt,
          cancelRequestedAt: run.cancelRequestedAt!,
        }));
    });
  }

  async reportRun(input: ReportRunStatusInput & { runId: string; deviceId: string }): Promise<Run> {
    return this.write(() => {
      const device = this.activeDevice(input.deviceId);
      device.lastSeenAt = new Date().toISOString();
      const run = this.runs.find((candidate) => candidate.id === input.runId) ?? notFound('Run');
      if (run.deviceId !== device.id) invalidState('The run is not assigned to this device');
      if (run.attempt !== input.attempt)
        conflict('run_attempt_changed', 'The run attempt changed before the device report arrived');
      if (run.status === input.status) {
        if (sameRunReport(run, input)) return structuredClone(run);
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
      const now = new Date().toISOString();
      run.status = input.status;
      run.errorCode = input.errorCode ?? null;
      if (input.result !== undefined) run.result = structuredClone(input.result);
      if (input.status === 'running' && !run.startedAt) run.startedAt = now;
      if (input.status === 'succeeded' || input.status === 'failed' || input.status === 'cancelled')
        run.finishedAt = now;
      this.audit(
        run.workspaceId,
        device.id,
        'run.status_reported',
        'run',
        run.id,
        {
          status: input.status,
          attempt: input.attempt,
        },
        'device',
      );
      return structuredClone(run);
    });
  }

  async listAuditEvents(workspaceId: string): Promise<AuditEventRecord[]> {
    return structuredClone(this.auditEvents.filter((candidate) => candidate.workspaceId === workspaceId));
  }

  async createApplication(input: ApplicationInput): Promise<Application> {
    return this.write(() => {
      if (
        this.applications.some(
          (candidate) => candidate.workspaceId === input.workspaceId && candidate.slug === input.slug,
        )
      )
        conflict('application_slug_exists', 'An application already uses that slug in this workspace');
      const application: Application = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        slug: input.slug,
        name: input.name,
        summary: input.summary,
        kind: input.kind,
        createdAt: new Date().toISOString(),
      };
      this.applications.push(application);
      this.audit(
        application.workspaceId,
        input.createdBy,
        'application.created',
        'application',
        application.id,
        { kind: application.kind, slug: application.slug },
      );
      return structuredClone(application);
    });
  }

  async listApplications(workspaceId: string): Promise<Application[]> {
    return structuredClone(this.applications.filter((candidate) => candidate.workspaceId === workspaceId));
  }

  async getApplication(id: string): Promise<Application> {
    return structuredClone(
      this.applications.find((candidate) => candidate.id === id) ?? notFound('Application'),
    );
  }

  async createRelease(input: ReleaseInput): Promise<Release> {
    return this.write(() => {
      const application =
        this.applications.find((candidate) => candidate.id === input.applicationId) ??
        notFound('Application');
      if (
        this.releases.some(
          (candidate) =>
            candidate.applicationId === input.applicationId && candidate.version === input.version,
        )
      )
        conflict('release_version_exists', 'Release versions are immutable and cannot be reused');
      const release: Release = {
        id: randomUUID(),
        applicationId: input.applicationId,
        version: input.version,
        manifest: input.manifest,
        manifestSha256: input.manifestSha256,
        signature: input.signature,
        sbom: input.sbom,
        validationEvidence: [],
        status: 'draft',
        createdBy: input.createdBy,
        createdAt: new Date().toISOString(),
      };
      this.releases.push(release);
      this.audit(application.workspaceId, input.createdBy, 'release.created', 'release', release.id, {
        applicationId: application.id,
        version: release.version,
      });
      return structuredClone(release);
    });
  }

  async listReleases(input: ListReleasesQuery & { workspaceId: string }): Promise<ReleaseListItem[]> {
    const applicationById = new Map(
      this.applications
        .filter(
          (application) =>
            application.workspaceId === input.workspaceId && (!input.kind || application.kind === input.kind),
        )
        .map((application) => [application.id, application]),
    );
    return structuredClone(
      this.releases
        .filter(
          (release) =>
            applicationById.has(release.applicationId) &&
            (!input.applicationId || release.applicationId === input.applicationId) &&
            (!input.status || release.status === input.status),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((release) => ({
          application: applicationById.get(release.applicationId)!,
          release,
          artifactCount: this.artifacts.filter((artifact) => artifact.releaseId === release.id).length,
          reviewCount: this.reviews.filter((review) => review.releaseId === release.id).length,
        })),
    );
  }

  async getRelease(id: string): Promise<Release> {
    return structuredClone(this.releases.find((candidate) => candidate.id === id) ?? notFound('Release'));
  }

  async createArtifact(input: ArtifactInput): Promise<Artifact> {
    return this.write(() => {
      const release =
        this.releases.find((candidate) => candidate.id === input.releaseId) ?? notFound('Release');
      if (release.status !== 'draft' && release.status !== 'uploading')
        invalidState('Artifacts can only be registered while a release is uploading');
      if (
        this.artifacts.some(
          (candidate) => candidate.releaseId === input.releaseId && candidate.fileName === input.fileName,
        )
      )
        conflict('artifact_name_exists', 'That artifact name is already registered');
      const artifact: Artifact = {
        id: randomUUID(),
        ...input,
        status: 'pending_upload',
        validationEvidence: [],
        createdAt: new Date().toISOString(),
      };
      this.artifacts.push(artifact);
      release.status = 'uploading';
      return structuredClone(artifact);
    });
  }

  async finalizeArtifact(id: string, _etag: string | undefined): Promise<Artifact> {
    return this.write(() => {
      const artifact = this.artifacts.find((candidate) => candidate.id === id) ?? notFound('Artifact');
      if (artifact.status !== 'pending_upload')
        invalidState('The artifact upload has already been finalized');
      artifact.status = 'uploaded';
      artifact.finalizedAt = new Date().toISOString();
      return structuredClone(artifact);
    });
  }

  async getArtifact(id: string): Promise<Artifact> {
    return structuredClone(this.artifacts.find((candidate) => candidate.id === id) ?? notFound('Artifact'));
  }

  async submitRelease(id: string): Promise<ReleaseStatusView> {
    return this.write(() => {
      const release = this.releases.find((candidate) => candidate.id === id) ?? notFound('Release');
      const artifacts = this.artifacts.filter((candidate) => candidate.releaseId === id);
      if (release.status !== 'draft' && release.status !== 'uploading')
        invalidState('Only a draft or uploading release can be submitted');
      if (
        artifacts.length !== release.manifest.artifacts.length ||
        artifacts.some((candidate) => candidate.status !== 'uploaded')
      )
        invalidState('Every declared artifact must be uploaded and finalized before submission');
      release.status = 'validating';
      return this.statusView(release);
    });
  }

  async applyValidationResult(input: {
    releaseId: string;
    success: boolean;
    artifactIds: string[];
    releaseEvidence: import('@awesome-workflow/contracts').ValidationEvidence[];
    artifactEvidence: Record<string, import('@awesome-workflow/contracts').ValidationEvidence[]>;
  }): Promise<ReleaseStatusView> {
    return this.write(() => {
      const release =
        this.releases.find((candidate) => candidate.id === input.releaseId) ?? notFound('Release');
      const releaseArtifacts = this.artifacts.filter((candidate) => candidate.releaseId === release.id);
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
        if (alreadyApplied) return this.statusView(release);
        invalidState('Validation results are accepted only for validating releases');
      }
      for (const artifact of releaseArtifacts) {
        artifact.status = input.success ? 'validated' : 'rejected';
        artifact.validationEvidence = structuredClone(input.artifactEvidence[artifact.id] ?? []);
      }
      release.validationEvidence = structuredClone(input.releaseEvidence);
      release.status = input.success ? 'ready' : 'rejected';
      return this.statusView(release);
    });
  }

  async createReview(input: {
    releaseId: string;
    reviewerId: string;
    decision: 'approve' | 'reject';
    comment: string;
  }): Promise<ReleaseStatusView> {
    return this.write(() => {
      const release =
        this.releases.find((candidate) => candidate.id === input.releaseId) ?? notFound('Release');
      if (release.status !== 'ready') invalidState('Only a ready release can be reviewed');
      const review: ReleaseReview = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
      this.reviews.push(review);
      release.status = input.decision === 'approve' ? 'approved' : 'rejected';
      const application =
        this.applications.find((candidate) => candidate.id === release.applicationId) ??
        notFound('Application');
      this.audit(application.workspaceId, input.reviewerId, 'release.reviewed', 'release', release.id, {
        decision: input.decision,
        reviewId: review.id,
      });
      return this.statusView(release);
    });
  }

  async getReleaseStatus(id: string): Promise<ReleaseStatusView> {
    return this.statusView(this.releases.find((candidate) => candidate.id === id) ?? notFound('Release'));
  }

  async promote(input: {
    applicationId: string;
    releaseId: string;
    channel: ReleaseChannelName;
    promotedBy: string;
    expectedCurrentReleaseId?: string | null;
  }): Promise<CatalogEntry> {
    return this.write(() => {
      const application =
        this.applications.find((candidate) => candidate.id === input.applicationId) ??
        notFound('Application');
      const release =
        this.releases.find((candidate) => candidate.id === input.releaseId) ?? notFound('Release');
      if (release.applicationId !== application.id || release.status !== 'approved')
        invalidState('Only an approved release belonging to this application can be promoted');
      const currentIndex = this.channels.findIndex(
        (candidate) => candidate.applicationId === input.applicationId && candidate.name === input.channel,
      );
      const current = currentIndex >= 0 ? this.channels[currentIndex] : undefined;
      if (
        input.expectedCurrentReleaseId !== undefined &&
        (current?.releaseId ?? null) !== input.expectedCurrentReleaseId
      )
        conflict('channel_changed', 'The channel changed since it was read');
      const channel: ChannelRecord = {
        applicationId: application.id,
        name: input.channel,
        releaseId: release.id,
        promotedBy: input.promotedBy,
        promotedAt: new Date().toISOString(),
      };
      if (currentIndex >= 0) this.channels[currentIndex] = channel;
      else this.channels.push(channel);
      this.audit(
        application.workspaceId,
        input.promotedBy,
        'channel.promoted',
        'application',
        application.id,
        {
          channel: input.channel,
          previousReleaseId: current?.releaseId ?? null,
          releaseId: release.id,
        },
      );
      return this.catalogEntry(application, release, channel);
    });
  }

  async listCatalog(input: {
    workspaceId: string;
    channel: ReleaseChannelName;
    kind?: 'web' | 'desktop';
  }): Promise<CatalogEntry[]> {
    return this.channels
      .filter((candidate) => candidate.name === input.channel)
      .flatMap((channel) => {
        const application = this.applications.find((candidate) => candidate.id === channel.applicationId);
        const release = this.releases.find((candidate) => candidate.id === channel.releaseId);
        if (
          !application ||
          !release ||
          application.workspaceId !== input.workspaceId ||
          (input.kind && application.kind !== input.kind)
        )
          return [];
        return [this.catalogEntry(application, release, channel)];
      });
  }

  private statusView(release: Release): ReleaseStatusView {
    return structuredClone({
      release,
      artifacts: this.artifacts.filter((candidate) => candidate.releaseId === release.id),
      reviews: this.reviews.filter((candidate) => candidate.releaseId === release.id),
    });
  }

  private catalogEntry(application: Application, release: Release, channel: ChannelRecord): CatalogEntry {
    return structuredClone({
      applicationId: application.id,
      workspaceId: application.workspaceId,
      slug: application.slug,
      name: application.name,
      summary: application.summary,
      kind: application.kind,
      releaseId: release.id,
      version: release.version,
      channel: channel.name,
      manifest: release.manifest,
      promotedAt: channel.promotedAt,
    });
  }

  private activeDevice(id: string): StoredDevice {
    const device = this.devices.find((candidate) => candidate.id === id) ?? notFound('Device');
    if (device.status !== 'active') invalidState('The device has been revoked');
    return device;
  }

  private async hasActivePermissionGrant(deviceId: string, releaseId: string, now: Date): Promise<boolean> {
    try {
      await this.requireActivePermissionGrant({ deviceId, releaseId, now });
      return true;
    } catch (error) {
      if (error instanceof DomainError && error.code === 'permission_approval_required') return false;
      throw error;
    }
  }

  private desktopRelease(
    applicationId: string,
    releaseId: string,
    workspaceId: string,
  ): { application: Application; release: Release; manifest: DesktopReleaseManifest } {
    const application =
      this.applications.find((candidate) => candidate.id === applicationId) ?? notFound('Application');
    const release = this.releases.find((candidate) => candidate.id === releaseId) ?? notFound('Release');
    if (
      application.workspaceId !== workspaceId ||
      application.kind !== 'desktop' ||
      release.applicationId !== application.id ||
      release.status !== 'approved' ||
      release.manifest.kind !== 'desktop'
    )
      invalidState('Only an approved desktop release belonging to the workspace can be used');
    return { application, release, manifest: DesktopReleaseManifestSchema.parse(release.manifest) };
  }

  private nextScheduleRevision(workspaceId: string): number {
    const revision = (this.scheduleWorkspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.scheduleWorkspaceRevisions.set(workspaceId, revision);
    return revision;
  }

  private scheduleRecord(schedule: Schedule): ScheduleRecord {
    const application =
      this.applications.find((candidate) => candidate.id === schedule.applicationId) ??
      notFound('Application');
    const release =
      this.releases.find((candidate) => candidate.id === schedule.releaseId) ?? notFound('Release');
    return {
      scheduleId: schedule.id,
      appId: application.slug,
      version: release.version,
      cronExpression: schedule.cronExpression,
      timezone: schedule.timezone,
      nextRunAtMs: schedule.nextRunAtMs,
      args: [...schedule.input.args],
      enabled: schedule.status === 'active',
    };
  }

  private audit(
    workspaceId: string,
    actorId: string,
    action: string,
    subjectType: string,
    subjectId: string,
    metadata: Record<string, unknown> = {},
    actorType: AuditEventRecord['actorType'] = 'user',
  ): void {
    this.auditEvents.push({
      id: randomUUID(),
      workspaceId,
      actorType,
      actorId,
      action,
      subjectType,
      subjectId,
      metadata: structuredClone(metadata),
      createdAt: new Date().toISOString(),
    });
  }

  private revokeRefreshFamily(familyId: string, now: Date): void {
    for (const refresh of this.refreshTokens) {
      if (refresh.familyId === familyId && !refresh.revokedAt) refresh.revokedAt = now;
    }
    for (const session of this.sessions) {
      if (session.refreshFamilyId === familyId && !session.revokedAt) session.revokedAt = now;
    }
  }

  private async write<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult> {
    let result!: TResult;
    const current = this.writeQueue.then(async () => {
      result = await operation();
    });
    this.writeQueue = current.catch(() => undefined);
    await current;
    return result;
  }
}

function publicDevice(device: StoredDevice): Device {
  return structuredClone({
    id: device.id,
    workspaceId: device.workspaceId,
    ownerId: device.ownerId,
    name: device.name,
    os: device.os,
    arch: device.arch,
    agentVersion: device.agentVersion,
    publicKeyThumbprint: device.publicKeyThumbprint,
    status: device.status,
    lastSeenAt: device.lastSeenAt,
    createdAt: device.createdAt,
  });
}

function materializePermissionGrant(grant: PermissionGrant, now: Date): PermissionGrant {
  if (grant.status !== 'active' || !grant.expiresAt || Date.parse(grant.expiresAt) > now.getTime()) {
    return grant;
  }
  return { ...grant, status: 'expired' };
}

function sameRunReport(run: Run, input: ReportRunStatusInput): boolean {
  const resultMatches =
    input.result === undefined ? run.result === null : isDeepStrictEqual(run.result, input.result);
  return resultMatches && run.errorCode === (input.errorCode ?? null);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
