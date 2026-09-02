import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type {
  ApprovePermissionGrantInput,
  ClaimRunsInput,
  CreateApplicationInput,
  CreateArtifactInput,
  CreateManualRunInput,
  CreateReleaseInput,
  CreateScheduleInput,
  CurrentUser,
  Device,
  FinalizeArtifactInput,
  Installation,
  InstallationSyncItem,
  InstallationSyncQuery,
  InstallationSyncResult,
  ListDevicesQuery,
  ListInstallationsQuery,
  ListPermissionGrantsQuery,
  ListReleasesQuery,
  ListReviewQueueQuery,
  ListRunsQuery,
  ListSchedulesQuery,
  PauseScheduleInput,
  PermissionGrantPreview,
  PlatformRole,
  PromoteReleaseInputV1,
  RegisterDeviceInput,
  ReportRunStatusInput,
  ReleaseChannelName,
  ReleaseStatusView,
  RequestInstallationInput,
  ReviewReleaseInput,
  ScheduleSyncQuery,
  UpdateInstallationStatusInput,
  UpdateScheduleInput,
  ValidationEvidence,
  WorkspaceRole,
} from '@awesome-workflow/contracts';
import {
  canonicalizeManifest,
  computeArtifactSetIntegritySha256,
  computeDesktopCapabilityHash,
  DesktopReleaseManifestSchema,
} from '@awesome-workflow/manifest-schema';

import { DomainError, forbidden, invalidState } from '../../core/errors.js';
import { PLATFORM_REPOSITORY, type PlatformRepository } from '../../core/repository.js';
import { hashDeviceCredential, issueDeviceCredential } from '../../http/device-auth.js';
import { OBJECT_STORAGE, type ObjectStoragePort } from './object-storage.port.js';
import { VALIDATION_QUEUE, type ValidationQueuePort } from './validation-queue.port.js';

const WRITE_ROLES: WorkspaceRole[] = ['owner', 'admin', 'developer'];

@Injectable()
export class ControlPlaneService {
  constructor(
    @Inject(PLATFORM_REPOSITORY) private readonly repository: PlatformRepository,
    @Inject(OBJECT_STORAGE) private readonly objectStorage: ObjectStoragePort,
    @Inject(VALIDATION_QUEUE) private readonly validationQueue: ValidationQueuePort,
  ) {}

  async listWorkspaces(actor: CurrentUser) {
    return this.repository.listWorkspaces(actor.id);
  }

  async createWorkspace(actor: CurrentUser, input: { slug: string; name: string }) {
    return this.repository.createWorkspace({ ...input, userId: actor.id });
  }

  async registerDevice(actor: CurrentUser, input: RegisterDeviceInput) {
    await this.requireWorkspaceRole(actor, input.workspaceId);
    const credential = issueDeviceCredential();
    const device = await this.repository.registerDevice({
      ...input,
      ownerId: actor.id,
      credentialHash: hashDeviceCredential(credential),
    });
    return { device, credential };
  }

  async listDevices(actor: CurrentUser, input: ListDevicesQuery) {
    await this.requireWorkspaceRole(actor, input.workspaceId);
    return this.repository.listDevices(input);
  }

  async device(actor: CurrentUser, deviceId: string) {
    const device = await this.repository.getDevice(deviceId);
    await this.requireWorkspaceRole(actor, device.workspaceId);
    return device;
  }

  async revokeDevice(actor: CurrentUser, deviceId: string) {
    const device = await this.repository.getDevice(deviceId);
    const role = await this.requireWorkspaceRole(actor, device.workspaceId);
    if (device.ownerId !== actor.id && !['owner', 'admin'].includes(role)) {
      forbidden('Only the device owner or a workspace administrator can revoke a device');
    }
    return this.repository.revokeDevice(deviceId, actor.id);
  }

  async requestInstallation(actor: CurrentUser, input: RequestInstallationInput) {
    await this.requireWorkspaceRole(actor, input.workspaceId);
    await this.requireActiveDeviceOwner(actor, input.deviceId, input.workspaceId);
    return this.repository.requestInstallation({ ...input, requestedBy: actor.id });
  }

  async installation(actor: CurrentUser, installationId: string) {
    const installation = await this.repository.getInstallation(installationId);
    await this.requireWorkspaceRole(actor, installation.workspaceId);
    return installation;
  }

  async listInstallations(actor: CurrentUser, input: ListInstallationsQuery) {
    await this.requireWorkspaceRole(actor, input.workspaceId);
    return this.repository.listInstallations(input);
  }

  async permissionRequirement(
    actor: CurrentUser,
    deviceId: string,
    releaseId: string,
  ): Promise<PermissionGrantPreview> {
    const device = await this.repository.getDevice(deviceId);
    const role = await this.requireWorkspaceRole(actor, device.workspaceId);
    this.requireDeviceOwnerOrWorkspaceAdministrator(
      actor,
      device,
      role,
      'Only the device owner or a workspace administrator can preview permission requirements',
    );
    if (device.status !== 'active') invalidState('The target device has been revoked');

    const release = await this.repository.getRelease(releaseId);
    const application = await this.repository.getApplication(release.applicationId);
    const storedManifest = release.manifest;
    if (
      application.workspaceId !== device.workspaceId ||
      application.kind !== 'desktop' ||
      release.applicationId !== application.id ||
      release.status !== 'approved' ||
      storedManifest.kind !== 'desktop'
    ) {
      invalidState('Only an approved desktop release belonging to the device workspace can be previewed');
    }

    const manifest = DesktopReleaseManifestSchema.parse(storedManifest);
    const capabilityHash = await computeDesktopCapabilityHash(manifest.capabilities);
    const activeGrants = await this.repository.listPermissionGrants({
      workspaceId: device.workspaceId,
      deviceId: device.id,
      applicationId: application.id,
      status: 'active',
    });
    return {
      workspaceId: device.workspaceId,
      deviceId: device.id,
      applicationId: application.id,
      releaseId: release.id,
      capabilities: manifest.capabilities,
      capabilityHash,
      approvalRequired: !activeGrants.some(
        (grant) => grant.releaseId === release.id && grant.capabilityHash === capabilityHash,
      ),
    };
  }

  async approvePermissionGrant(actor: CurrentUser, deviceId: string, input: ApprovePermissionGrantInput) {
    const device = await this.repository.getDevice(deviceId);
    await this.requireWorkspaceRole(actor, device.workspaceId);
    await this.requireActiveDeviceOwner(actor, device.id, device.workspaceId);
    return this.repository.approvePermissionGrant({
      deviceId: device.id,
      releaseId: input.releaseId,
      grantedBy: actor.id,
      expectedCapabilityHash: input.expectedCapabilityHash,
      ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
      now: new Date(),
    });
  }

  async listPermissionGrants(actor: CurrentUser, input: ListPermissionGrantsQuery) {
    await this.requireWorkspaceRole(actor, input.workspaceId);
    return this.repository.listPermissionGrants(input);
  }

  async revokePermissionGrant(actor: CurrentUser, grantId: string) {
    const grant = await this.repository.getPermissionGrant(grantId);
    const [role, device] = await Promise.all([
      this.requireWorkspaceRole(actor, grant.workspaceId),
      this.repository.getDevice(grant.deviceId),
    ]);
    if (device.workspaceId !== grant.workspaceId) {
      invalidState('The permission grant device no longer belongs to its recorded workspace');
    }
    this.requireDeviceOwnerOrWorkspaceAdministrator(
      actor,
      device,
      role,
      'Only the device owner or a workspace administrator can revoke a permission grant',
    );
    return this.repository.revokePermissionGrant(grant.id, actor.id);
  }

  async updateInstallationStatus(
    device: Device,
    deviceId: string,
    installationId: string,
    input: UpdateInstallationStatusInput,
  ) {
    this.requireDeviceScope(device, deviceId);
    const installation = await this.repository.getInstallation(installationId);
    this.requireDeviceScope(device, installation.deviceId);
    return this.repository.updateInstallationStatus({
      id: installationId,
      deviceId: device.id,
      status: input.status,
      errorCode: input.errorCode,
    });
  }

  async syncInstallations(
    device: Device,
    deviceId: string,
    input: InstallationSyncQuery,
  ): Promise<InstallationSyncResult> {
    this.requireDeviceScope(device, deviceId);
    const index = await this.repository.syncInstallations(device.id, input);
    if (!index.changed) return { kind: 'unchanged', revision: index.revision };
    return {
      kind: 'snapshot',
      snapshot: {
        revision: index.revision,
        installations: await Promise.all(
          index.installations.map((installation) => this.installationSyncItem(device, installation)),
        ),
      },
    };
  }

  async createSchedule(actor: CurrentUser, input: CreateScheduleInput) {
    await this.requireWorkspaceRole(actor, input.workspaceId);
    await this.requireActiveDeviceOwner(actor, input.targetDeviceId, input.workspaceId);
    return this.repository.createSchedule({ ...input, createdBy: actor.id });
  }

  private async installationSyncItem(
    device: Device,
    installation: Installation,
  ): Promise<InstallationSyncItem> {
    if (!['requested', 'downloading', 'installed'].includes(installation.status)) {
      throw new DomainError(
        409,
        'installation_not_actionable',
        'The installation is not actionable by the device',
      );
    }
    const [application, release, releaseStatus] = await Promise.all([
      this.repository.getApplication(installation.applicationId),
      this.repository.getRelease(installation.releaseId),
      this.repository.getReleaseStatus(installation.releaseId),
    ]);
    if (
      application.kind !== 'desktop' ||
      release.status !== 'approved' ||
      release.applicationId !== application.id ||
      release.manifest.kind !== 'desktop' ||
      release.manifest.appId !== application.slug ||
      release.manifest.version !== release.version
    ) {
      throw new DomainError(
        409,
        'installation_release_invalid',
        'The installation no longer resolves to an approved desktop release',
      );
    }
    const runtime = release.manifest.runtimes.find(
      (candidate) => candidate.platform.os === device.os && candidate.platform.arch === device.arch,
    );
    const declaration = runtime
      ? release.manifest.artifacts.find((candidate) => candidate.name === runtime.artifact)
      : undefined;
    const artifact = declaration
      ? releaseStatus.artifacts.find(
          (candidate) =>
            candidate.status === 'validated' &&
            candidate.fileName === declaration.fileName &&
            candidate.contentType === declaration.mediaType &&
            candidate.size === declaration.size &&
            candidate.sha256 === declaration.sha256,
        )
      : undefined;
    if (!runtime || !declaration || !artifact) {
      throw new DomainError(
        409,
        'installation_artifact_unavailable',
        'The release has no validated artifact for this device platform',
      );
    }
    await this.repository.requireActivePermissionGrant({
      deviceId: device.id,
      releaseId: release.id,
      now: new Date(),
    });
    const download = await this.objectStorage.createDownload(artifact.storageKey);
    return {
      installationId: installation.id,
      status: installation.status as InstallationSyncItem['status'],
      appId: application.slug,
      version: release.version,
      manifest: release.manifest,
      artifact: {
        name: declaration.name,
        fileName: declaration.fileName,
        mediaType: declaration.mediaType,
        size: declaration.size,
        sha256: declaration.sha256,
        downloadUrl: download.url,
        downloadExpiresAt: download.expiresAt,
        attestation: artifact.signature,
      },
    };
  }

  async schedule(actor: CurrentUser, scheduleId: string) {
    const schedule = await this.repository.getSchedule(scheduleId);
    await this.requireWorkspaceRole(actor, schedule.workspaceId);
    return schedule;
  }

  async listSchedules(actor: CurrentUser, input: ListSchedulesQuery) {
    await this.requireWorkspaceRole(actor, input.workspaceId);
    return this.repository.listSchedules(input);
  }

  async updateSchedule(actor: CurrentUser, scheduleId: string, input: UpdateScheduleInput) {
    const schedule = await this.repository.getSchedule(scheduleId);
    const role = await this.requireWorkspaceRole(actor, schedule.workspaceId);
    await this.authorizeScheduleWrite(actor, role, schedule.workspaceId, schedule.targetDeviceId);
    if (input.targetDeviceId) {
      await this.requireActiveDeviceOwner(actor, input.targetDeviceId, schedule.workspaceId);
    }
    return this.repository.updateSchedule(scheduleId, { ...input, actorId: actor.id });
  }

  async pauseSchedule(actor: CurrentUser, scheduleId: string, input: PauseScheduleInput) {
    const schedule = await this.repository.getSchedule(scheduleId);
    const role = await this.requireWorkspaceRole(actor, schedule.workspaceId);
    await this.authorizeScheduleWrite(actor, role, schedule.workspaceId, schedule.targetDeviceId);
    return this.repository.pauseSchedule(scheduleId, { ...input, actorId: actor.id });
  }

  async syncSchedules(device: Device, deviceId: string, input: ScheduleSyncQuery) {
    this.requireDeviceScope(device, deviceId);
    return this.repository.syncSchedules(device.id, input);
  }

  async createManualRun(actor: CurrentUser, input: CreateManualRunInput) {
    await this.requireWorkspaceRole(actor, input.workspaceId);
    await this.requireActiveDeviceOwner(actor, input.deviceId, input.workspaceId);
    return this.repository.createManualRun({ ...input, triggeredBy: actor.id });
  }

  async run(actor: CurrentUser, runId: string) {
    const run = await this.repository.getRun(runId);
    await this.requireWorkspaceRole(actor, run.workspaceId);
    return run;
  }

  async listRuns(actor: CurrentUser, input: ListRunsQuery) {
    await this.requireWorkspaceRole(actor, input.workspaceId);
    return this.repository.listRuns(input);
  }

  async cancelRun(actor: CurrentUser, runId: string) {
    const run = await this.repository.getRun(runId);
    const role = await this.requireWorkspaceRole(actor, run.workspaceId);
    const device = await this.repository.getDevice(run.deviceId);
    if (device.ownerId !== actor.id && !['owner', 'admin'].includes(role)) {
      forbidden('Only the target device owner or a workspace administrator can cancel this run');
    }
    return this.repository.cancelRun(runId, actor.id);
  }

  async claimRuns(device: Device, deviceId: string, input: ClaimRunsInput) {
    this.requireDeviceScope(device, deviceId);
    return this.repository.claimRuns(device.id, input);
  }

  async runControl(device: Device, deviceId: string) {
    this.requireDeviceScope(device, deviceId);
    return this.repository.listRunCancellations(device.id);
  }

  async reportRun(device: Device, deviceId: string, runId: string, input: ReportRunStatusInput) {
    this.requireDeviceScope(device, deviceId);
    const run = await this.repository.getRun(runId);
    this.requireDeviceScope(device, run.deviceId);
    return this.repository.reportRun({ ...input, deviceId: device.id, runId });
  }

  async listAuditEvents(actor: CurrentUser, workspaceId: string) {
    await this.requireWorkspaceRole(actor, workspaceId);
    return this.repository.listAuditEvents(workspaceId);
  }

  async listApplications(actor: CurrentUser, workspaceId: string) {
    await this.requireWorkspaceRole(actor, workspaceId);
    return this.repository.listApplications(workspaceId);
  }

  async createApplication(actor: CurrentUser, workspaceId: string, input: CreateApplicationInput) {
    await this.requireWorkspaceRole(actor, workspaceId, WRITE_ROLES);
    return this.repository.createApplication({ ...input, workspaceId, createdBy: actor.id });
  }

  async listReleases(actor: CurrentUser, workspaceId: string, input: ListReleasesQuery) {
    await this.requireWorkspaceRole(actor, workspaceId);
    return this.repository.listReleases({ ...input, workspaceId });
  }

  async listPendingReviews(actor: CurrentUser, input: ListReviewQueueQuery) {
    await this.requireWorkspaceRole(actor, input.workspaceId);
    return this.repository.listReleases({ ...input, status: 'ready' });
  }

  async createRelease(actor: CurrentUser, applicationId: string, input: CreateReleaseInput) {
    const application = await this.repository.getApplication(applicationId);
    await this.requireWorkspaceRole(actor, application.workspaceId, WRITE_ROLES);
    if (input.manifest.appId !== application.slug || input.manifest.version !== input.version) {
      throw new DomainError(
        400,
        'manifest_identity_mismatch',
        'Manifest appId and version must match the target application release',
      );
    }
    if (
      input.manifest.signature.keyId !== input.signature.keyId ||
      input.manifest.signature.value !== input.signature.value
    ) {
      throw new DomainError(
        400,
        'manifest_signature_mismatch',
        'Release signature must match the signed manifest envelope',
      );
    }
    if (
      (await computeArtifactSetIntegritySha256(input.manifest.artifacts)) !== input.manifest.integrity.digest
    ) {
      throw new DomainError(
        400,
        'manifest_integrity_mismatch',
        'Manifest integrity must be the SHA-256 of the canonical artifact descriptor set',
      );
    }
    const manifestSha256 = createHash('sha256').update(canonicalizeManifest(input.manifest)).digest('hex');
    return this.repository.createRelease({ ...input, applicationId, manifestSha256, createdBy: actor.id });
  }

  async createArtifact(actor: CurrentUser, releaseId: string, input: CreateArtifactInput) {
    const release = await this.authorizeRelease(actor, releaseId, WRITE_ROLES);
    const declaration = release.manifest.artifacts.find((artifact) => artifact.fileName === input.fileName);
    if (
      !declaration ||
      declaration.sha256 !== input.sha256 ||
      declaration.size !== input.size ||
      declaration.mediaType !== input.contentType
    ) {
      throw new DomainError(
        400,
        'artifact_not_declared',
        'Artifact file, media type, size, and digest must match the immutable manifest',
      );
    }
    if (input.signature.keyId !== release.signature.keyId) {
      throw new DomainError(
        400,
        'artifact_signer_mismatch',
        'Artifact and release signatures must use the same publisher key',
      );
    }
    const artifactId = randomUUID();
    const storageKey = `objects/sha256/${input.sha256}/${input.fileName}`;
    const sbomStorageKey = `objects/sha256/${input.sbom.sha256}/${input.sbom.fileName}`;
    const [upload, sbomUpload] = await Promise.all([
      this.objectStorage.createUpload({
        key: storageKey,
        contentType: input.contentType,
        sha256: input.sha256,
        size: input.size,
      }),
      this.objectStorage.createUpload({
        key: sbomStorageKey,
        contentType: input.sbom.mediaType,
        sha256: input.sbom.sha256,
      }),
    ]);
    const artifact = await this.repository.createArtifact({
      ...input,
      releaseId,
      storageKey,
      sbomStorageKey,
    });
    return {
      artifact,
      upload,
      sbomUpload,
    };
  }

  async finalizeArtifact(actor: CurrentUser, artifactId: string, input: FinalizeArtifactInput) {
    const artifact = await this.repository.getArtifact(artifactId);
    await this.authorizeRelease(actor, artifact.releaseId, WRITE_ROLES);
    await Promise.all([
      this.objectStorage.assertUploaded({
        key: artifact.storageKey,
        contentType: artifact.contentType,
        sha256: artifact.sha256,
        size: artifact.size,
      }),
      this.objectStorage.assertUploaded({
        key: artifact.sbomStorageKey,
        contentType: artifact.sbom.mediaType,
        sha256: artifact.sbom.sha256,
      }),
    ]);
    return this.repository.finalizeArtifact(artifactId, input.etag);
  }

  async submitRelease(actor: CurrentUser, releaseId: string): Promise<ReleaseStatusView> {
    await this.authorizeRelease(actor, releaseId, WRITE_ROLES);
    const current = await this.repository.getReleaseStatus(releaseId);
    const status =
      current.release.status === 'validating' ? current : await this.repository.submitRelease(releaseId);
    try {
      await this.validationQueue.enqueue({
        releaseId,
        manifest: status.release.manifest,
        artifacts: await Promise.all(
          status.artifacts.map(async (artifact) => ({
            artifactId: artifact.id,
            fileName: artifact.fileName,
            url: (await this.objectStorage.createDownload(artifact.storageKey)).url,
            expectedSha256: artifact.sha256,
            expectedSize: artifact.size,
            signature: artifact.signature,
            sbom: {
              ...artifact.sbom,
              url: (await this.objectStorage.createDownload(artifact.sbomStorageKey)).url,
            },
          })),
        ),
      });
    } catch {
      throw new DomainError(
        503,
        'validation_queue_unavailable',
        'The release is validating but the validation job could not be queued; retry submission safely',
      );
    }
    return status;
  }

  async applyValidation(input: {
    releaseId: string;
    success: boolean;
    artifactIds: string[];
    releaseEvidence: ValidationEvidence[];
    artifactEvidence: Record<string, ValidationEvidence[]>;
  }) {
    return this.repository.applyValidationResult(input);
  }

  async reviewRelease(actor: CurrentUser, releaseId: string, input: ReviewReleaseInput) {
    this.requirePlatformRole(actor, ['official_reviewer', 'platform_admin']);
    return this.repository.createReview({ ...input, releaseId, reviewerId: actor.id });
  }

  async releaseStatus(actor: CurrentUser, releaseId: string) {
    await this.authorizeRelease(actor, releaseId);
    return this.repository.getReleaseStatus(releaseId);
  }

  async promote(
    actor: CurrentUser,
    applicationId: string,
    channel: ReleaseChannelName,
    input: PromoteReleaseInputV1,
  ) {
    const application = await this.repository.getApplication(applicationId);
    await this.requireWorkspaceRole(actor, application.workspaceId, ['owner', 'admin']);
    return this.repository.promote({ ...input, applicationId, channel, promotedBy: actor.id });
  }

  async catalog(
    actor: CurrentUser,
    input: { workspaceId: string; channel: ReleaseChannelName; kind?: 'web' | 'desktop' },
  ) {
    await this.requireWorkspaceRole(actor, input.workspaceId);
    return this.repository.listCatalog(input);
  }

  private async authorizeRelease(actor: CurrentUser, releaseId: string, roles?: WorkspaceRole[]) {
    const release = await this.repository.getRelease(releaseId);
    const application = await this.repository.getApplication(release.applicationId);
    await this.requireWorkspaceRole(actor, application.workspaceId, roles);
    return release;
  }

  private async requireWorkspaceRole(
    actor: CurrentUser,
    workspaceId: string,
    allowed?: WorkspaceRole[],
  ): Promise<WorkspaceRole> {
    const role =
      (await this.repository.getWorkspaceRole(workspaceId, actor.id)) ??
      forbidden('The workspace role does not permit this action');
    if (allowed && !allowed.includes(role)) forbidden('The workspace role does not permit this action');
    return role;
  }

  private async requireActiveDeviceOwner(actor: CurrentUser, deviceId: string, workspaceId: string) {
    const device = await this.repository.getDevice(deviceId);
    if (device.workspaceId !== workspaceId) {
      invalidState('The device does not belong to the requested workspace');
    }
    if (device.ownerId !== actor.id) {
      forbidden('The authenticated user does not own the target device');
    }
    if (device.status !== 'active') {
      invalidState('The target device has been revoked');
    }
    return device;
  }

  private requireDeviceScope(device: Device, targetDeviceId: string): void {
    if (device.id !== targetDeviceId) {
      forbidden('A device credential can access only its own Agent resources');
    }
  }

  private requireDeviceOwnerOrWorkspaceAdministrator(
    actor: CurrentUser,
    device: Device,
    role: WorkspaceRole,
    message: string,
  ): void {
    if (device.ownerId !== actor.id && !['owner', 'admin'].includes(role)) forbidden(message);
  }

  private async authorizeScheduleWrite(
    actor: CurrentUser,
    role: WorkspaceRole,
    workspaceId: string,
    targetDeviceId: string | null,
  ): Promise<void> {
    if (targetDeviceId) {
      await this.requireActiveDeviceOwner(actor, targetDeviceId, workspaceId);
      return;
    }
    if (!WRITE_ROLES.includes(role)) {
      forbidden('A workspace developer role is required to change a workspace-wide schedule');
    }
  }

  private requirePlatformRole(actor: CurrentUser, allowed: PlatformRole[]): void {
    if (!actor.platformRoles.some((role) => allowed.includes(role)))
      forbidden('A platform reviewer role is required');
  }
}
