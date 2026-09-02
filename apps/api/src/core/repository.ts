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
  ScheduleSyncQuery,
  ScheduleSyncResult,
  UpdateScheduleInput,
  ValidationEvidence,
  Workspace,
  WorkspaceRole,
} from '@awesome-workflow/contracts';
import type { ReleaseManifest } from '@awesome-workflow/manifest-schema';

export const PLATFORM_REPOSITORY = Symbol('PLATFORM_REPOSITORY');

export type EmailChallengeRecord = {
  id: string;
  email: string;
  codeHash: string;
  attempts: number;
  createdAt: Date;
  expiresAt: Date;
  consumedAt?: Date;
};

export type OidcTransactionRecord = {
  id: string;
  stateHash: string;
  codeVerifier: string;
  nonce: string;
  provider?: string;
  returnTo?: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt?: Date;
};

export type CliAuthorizationRecord = {
  id: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  offlineAccess: boolean;
  createdAt: Date;
  expiresAt: Date;
};

export type RefreshSessionInput = {
  familyId: string;
  userId: string;
  accessTokenHash: string;
  accessExpiresAt: Date;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
  now: Date;
};

export type RotateRefreshSessionInput = {
  refreshTokenHash: string;
  nextRefreshTokenHash: string;
  nextAccessTokenHash: string;
  nextAccessExpiresAt: Date;
  now: Date;
};

export type RotateRefreshSessionResult =
  { status: 'rotated'; user: CurrentUser } | { status: 'invalid' | 'replayed' };

export type IdentityInput = {
  issuer: string;
  subject: string;
  email: string;
  displayName: string;
  platformRoles: CurrentUser['platformRoles'];
};

export type ApplicationInput = Pick<Application, 'workspaceId' | 'slug' | 'name' | 'summary' | 'kind'> & {
  createdBy: string;
};
export type ReleaseInput = {
  applicationId: string;
  version: string;
  manifest: ReleaseManifest;
  manifestSha256: string;
  signature: Release['signature'];
  sbom: Release['sbom'];
  createdBy: string;
};
export type ArtifactInput = Pick<
  Artifact,
  | 'releaseId'
  | 'fileName'
  | 'contentType'
  | 'size'
  | 'sha256'
  | 'signature'
  | 'sbom'
  | 'storageKey'
  | 'sbomStorageKey'
>;

export type AuditEventRecord = {
  id: string;
  workspaceId: string;
  actorType: 'user' | 'device';
  actorId: string;
  action: string;
  subjectType: string;
  subjectId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type InstallationSyncIndex = {
  revision: number;
  changed: boolean;
  installations: Installation[];
};

export type ApprovePermissionGrantRecordInput = {
  deviceId: string;
  releaseId: string;
  grantedBy: string;
  expectedCapabilityHash: string;
  expiresAt?: Date;
  now: Date;
};

export type PermissionGrantRequirementInput = {
  deviceId: string;
  releaseId: string;
  now: Date;
};

export interface PlatformRepository {
  findLatestEmailChallenge(email: string): Promise<EmailChallengeRecord | null>;
  findEmailChallengeById(id: string): Promise<EmailChallengeRecord | null>;
  createEmailChallenge(record: EmailChallengeRecord): Promise<void>;
  consumeEmailChallenge(id: string, suppliedHash: string, now: Date, maxAttempts: number): Promise<string>;
  createOidcTransaction(record: OidcTransactionRecord): Promise<void>;
  consumeOidcTransaction(stateHash: string, now: Date): Promise<OidcTransactionRecord>;
  createCliAuthorization(record: CliAuthorizationRecord): Promise<void>;
  authorizeCliRequest(
    id: string,
    userId: string,
    codeHash: string,
    now: Date,
  ): Promise<{ redirectUri: string; state: string }>;
  consumeCliAuthorization(input: {
    codeHash: string;
    redirectUri: string;
    codeChallenge: string;
    now: Date;
  }): Promise<{ user: CurrentUser; offlineAccess: boolean }>;
  upsertIdentity(input: IdentityInput): Promise<CurrentUser>;
  createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  createRefreshSession(input: RefreshSessionInput): Promise<void>;
  rotateRefreshSession(input: RotateRefreshSessionInput): Promise<RotateRefreshSessionResult>;
  findUserBySession(tokenHash: string, now: Date): Promise<CurrentUser | null>;
  revokeSessionFamily(tokenHash: string, now: Date): Promise<void>;

  listWorkspaces(userId: string): Promise<Workspace[]>;
  createWorkspace(input: { slug: string; name: string; userId: string }): Promise<Workspace>;
  getWorkspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;

  registerDevice(input: RegisterDeviceInput & { ownerId: string; credentialHash: string }): Promise<Device>;
  findActiveDeviceByCredentialHash(credentialHash: string): Promise<Device | null>;
  getDevice(id: string): Promise<Device>;
  listDevices(input: ListDevicesQuery): Promise<Device[]>;
  revokeDevice(id: string, actorId: string): Promise<Device>;

  requestInstallation(input: RequestInstallationInput & { requestedBy: string }): Promise<Installation>;
  getInstallation(id: string): Promise<Installation>;
  listInstallations(input: ListInstallationsQuery): Promise<Installation[]>;
  syncInstallations(deviceId: string, input: InstallationSyncQuery): Promise<InstallationSyncIndex>;
  updateInstallationStatus(input: {
    id: string;
    deviceId: string;
    status: InstallationStatus;
    errorCode?: string;
  }): Promise<Installation>;

  approvePermissionGrant(input: ApprovePermissionGrantRecordInput): Promise<PermissionGrant>;
  getPermissionGrant(id: string): Promise<PermissionGrant>;
  listPermissionGrants(input: ListPermissionGrantsQuery): Promise<PermissionGrant[]>;
  revokePermissionGrant(id: string, actorId: string): Promise<PermissionGrant>;
  requireActivePermissionGrant(input: PermissionGrantRequirementInput): Promise<PermissionGrant>;

  createSchedule(input: CreateScheduleInput & { createdBy: string }): Promise<Schedule>;
  getSchedule(id: string): Promise<Schedule>;
  listSchedules(input: ListSchedulesQuery): Promise<Schedule[]>;
  updateSchedule(id: string, input: UpdateScheduleInput & { actorId: string }): Promise<Schedule>;
  pauseSchedule(id: string, input: PauseScheduleInput & { actorId: string }): Promise<Schedule>;
  syncSchedules(deviceId: string, input: ScheduleSyncQuery): Promise<ScheduleSyncResult>;

  createManualRun(input: CreateManualRunInput & { triggeredBy: string }): Promise<Run>;
  getRun(id: string): Promise<Run>;
  listRuns(input: ListRunsQuery): Promise<Run[]>;
  cancelRun(id: string, actorId: string): Promise<Run>;
  claimRuns(deviceId: string, input: ClaimRunsInput): Promise<RunClaim[]>;
  listRunCancellations(deviceId: string): Promise<RunCancellation[]>;
  reportRun(input: ReportRunStatusInput & { runId: string; deviceId: string }): Promise<Run>;
  listAuditEvents(workspaceId: string): Promise<AuditEventRecord[]>;

  createApplication(input: ApplicationInput): Promise<Application>;
  listApplications(workspaceId: string): Promise<Application[]>;
  getApplication(id: string): Promise<Application>;
  createRelease(input: ReleaseInput): Promise<Release>;
  listReleases(input: ListReleasesQuery & { workspaceId: string }): Promise<ReleaseListItem[]>;
  getRelease(id: string): Promise<Release>;
  createArtifact(input: ArtifactInput): Promise<Artifact>;
  getArtifact(id: string): Promise<Artifact>;
  finalizeArtifact(id: string, etag: string | undefined): Promise<Artifact>;
  submitRelease(id: string): Promise<ReleaseStatusView>;
  applyValidationResult(input: {
    releaseId: string;
    success: boolean;
    artifactIds: string[];
    releaseEvidence: ValidationEvidence[];
    artifactEvidence: Record<string, ValidationEvidence[]>;
  }): Promise<ReleaseStatusView>;
  createReview(input: {
    releaseId: string;
    reviewerId: string;
    decision: 'approve' | 'reject';
    comment: string;
  }): Promise<ReleaseStatusView>;
  getReleaseStatus(id: string): Promise<ReleaseStatusView>;
  promote(input: {
    applicationId: string;
    releaseId: string;
    channel: ReleaseChannelName;
    promotedBy: string;
    expectedCurrentReleaseId?: string | null;
  }): Promise<CatalogEntry>;
  listCatalog(input: {
    workspaceId: string;
    channel: ReleaseChannelName;
    kind?: 'web' | 'desktop';
  }): Promise<CatalogEntry[]>;
}
