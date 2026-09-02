import { timingSafeEqual } from 'node:crypto';

import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import {
  ApprovePermissionGrantInputSchema,
  ClaimRunsInputSchema,
  CreateApplicationInputSchema,
  CreateArtifactInputSchema,
  CreateManualRunInputSchema,
  CreateReleaseInputSchema,
  CreateScheduleInputSchema,
  CreateWorkspaceInputSchema,
  FinalizeArtifactInputSchema,
  ListDevicesQuerySchema,
  ListInstallationsQuerySchema,
  ListPermissionGrantsQuerySchema,
  InstallationSyncQuerySchema,
  ListReleasesQuerySchema,
  ListReviewQueueQuerySchema,
  ListRunsQuerySchema,
  ListSchedulesQuerySchema,
  PauseScheduleInputSchema,
  PromoteReleaseInputV1Schema,
  RegisterDeviceInputSchema,
  ReportRunStatusInputSchema,
  ReleaseChannelNameSchema,
  ReleaseValidationResultSchema,
  RequestInstallationInputSchema,
  ReviewReleaseInputSchema,
  ScheduleSyncQuerySchema,
  UpdateInstallationStatusInputSchema,
  UpdateScheduleInputSchema,
  type CurrentUser,
  type Device,
} from '@awesome-workflow/contracts';
import { CONFIG, type PlatformConfig } from '@awesome-workflow/config';
import { Inject } from '@nestjs/common';

import { DomainError } from '../../core/errors.js';
import { Actor } from '../../http/actor.decorator.js';
import { DeviceActor } from '../../http/device-actor.decorator.js';
import { DeviceRoute } from '../../http/device-route.decorator.js';
import { Public } from '../../http/public.decorator.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import { ControlPlaneService } from './control-plane.service.js';

const UuidSchema = z.string().uuid();
const CatalogQuerySchema = z.object({
  workspaceId: z.string().uuid(),
  channel: ReleaseChannelNameSchema.default('stable'),
  kind: z.enum(['web', 'desktop']).optional(),
});

@Controller()
export class ControlPlaneController {
  constructor(
    @Inject(ControlPlaneService) private readonly controlPlane: ControlPlaneService,
    @Inject(CONFIG) private readonly config: PlatformConfig,
  ) {}

  @Get('workspaces')
  async listWorkspaces(@Actor() actor: CurrentUser) {
    return { data: await this.controlPlane.listWorkspaces(actor) };
  }

  @Post('workspaces')
  async createWorkspace(
    @Actor() actor: CurrentUser,
    @Body(new ZodPipe(CreateWorkspaceInputSchema)) input: z.infer<typeof CreateWorkspaceInputSchema>,
  ) {
    return { data: await this.controlPlane.createWorkspace(actor, input) };
  }

  @Post('devices')
  async registerDevice(
    @Actor() actor: CurrentUser,
    @Body(new ZodPipe(RegisterDeviceInputSchema)) input: z.infer<typeof RegisterDeviceInputSchema>,
  ) {
    return { data: await this.controlPlane.registerDevice(actor, input) };
  }

  @Get('devices')
  async listDevices(
    @Actor() actor: CurrentUser,
    @Query(new ZodPipe(ListDevicesQuerySchema)) input: z.infer<typeof ListDevicesQuerySchema>,
  ) {
    return { data: await this.controlPlane.listDevices(actor, input) };
  }

  @Post('devices/:deviceId/revoke')
  @HttpCode(200)
  async revokeDevice(
    @Actor() actor: CurrentUser,
    @Param('deviceId', new ZodPipe(UuidSchema)) deviceId: string,
  ) {
    return { data: await this.controlPlane.revokeDevice(actor, deviceId) };
  }

  @Post('installations')
  async requestInstallation(
    @Actor() actor: CurrentUser,
    @Body(new ZodPipe(RequestInstallationInputSchema)) input: z.infer<typeof RequestInstallationInputSchema>,
  ) {
    return { data: await this.controlPlane.requestInstallation(actor, input) };
  }

  @Get('installations')
  async listInstallations(
    @Actor() actor: CurrentUser,
    @Query(new ZodPipe(ListInstallationsQuerySchema)) input: z.infer<typeof ListInstallationsQuerySchema>,
  ) {
    return { data: await this.controlPlane.listInstallations(actor, input) };
  }

  @Get('installations/:installationId')
  async installation(
    @Actor() actor: CurrentUser,
    @Param('installationId', new ZodPipe(UuidSchema)) installationId: string,
  ) {
    return { data: await this.controlPlane.installation(actor, installationId) };
  }

  @DeviceRoute()
  @Post('devices/:deviceId/installations/:installationId/status')
  @HttpCode(200)
  async updateInstallationStatus(
    @DeviceActor() device: Device,
    @Param('deviceId', new ZodPipe(UuidSchema)) deviceId: string,
    @Param('installationId', new ZodPipe(UuidSchema)) installationId: string,
    @Body(new ZodPipe(UpdateInstallationStatusInputSchema))
    input: z.infer<typeof UpdateInstallationStatusInputSchema>,
  ) {
    return {
      data: await this.controlPlane.updateInstallationStatus(device, deviceId, installationId, input),
    };
  }

  @DeviceRoute()
  @Get('devices/:deviceId/installations/sync')
  async syncInstallations(
    @DeviceActor() device: Device,
    @Param('deviceId', new ZodPipe(UuidSchema)) deviceId: string,
    @Query(new ZodPipe(InstallationSyncQuerySchema))
    input: z.infer<typeof InstallationSyncQuerySchema>,
  ) {
    return { data: await this.controlPlane.syncInstallations(device, deviceId, input) };
  }

  @Get('devices/:deviceId/releases/:releaseId/permission-requirement')
  async permissionRequirement(
    @Actor() actor: CurrentUser,
    @Param('deviceId', new ZodPipe(UuidSchema)) deviceId: string,
    @Param('releaseId', new ZodPipe(UuidSchema)) releaseId: string,
  ) {
    return {
      data: await this.controlPlane.permissionRequirement(actor, deviceId, releaseId),
    };
  }

  @Post('devices/:deviceId/permission-grants')
  async approvePermissionGrant(
    @Actor() actor: CurrentUser,
    @Param('deviceId', new ZodPipe(UuidSchema)) deviceId: string,
    @Body(new ZodPipe(ApprovePermissionGrantInputSchema))
    input: z.infer<typeof ApprovePermissionGrantInputSchema>,
  ) {
    return { data: await this.controlPlane.approvePermissionGrant(actor, deviceId, input) };
  }

  @Get('permission-grants')
  async listPermissionGrants(
    @Actor() actor: CurrentUser,
    @Query(new ZodPipe(ListPermissionGrantsQuerySchema))
    input: z.infer<typeof ListPermissionGrantsQuerySchema>,
  ) {
    return { data: await this.controlPlane.listPermissionGrants(actor, input) };
  }

  @Post('permission-grants/:grantId/revoke')
  @HttpCode(200)
  async revokePermissionGrant(
    @Actor() actor: CurrentUser,
    @Param('grantId', new ZodPipe(UuidSchema)) grantId: string,
  ) {
    return { data: await this.controlPlane.revokePermissionGrant(actor, grantId) };
  }

  @Post('schedules')
  async createSchedule(
    @Actor() actor: CurrentUser,
    @Body(new ZodPipe(CreateScheduleInputSchema)) input: z.infer<typeof CreateScheduleInputSchema>,
  ) {
    return { data: await this.controlPlane.createSchedule(actor, input) };
  }

  @Get('schedules')
  async listSchedules(
    @Actor() actor: CurrentUser,
    @Query(new ZodPipe(ListSchedulesQuerySchema)) input: z.infer<typeof ListSchedulesQuerySchema>,
  ) {
    return { data: await this.controlPlane.listSchedules(actor, input) };
  }

  @Get('schedules/:scheduleId')
  async schedule(
    @Actor() actor: CurrentUser,
    @Param('scheduleId', new ZodPipe(UuidSchema)) scheduleId: string,
  ) {
    return { data: await this.controlPlane.schedule(actor, scheduleId) };
  }

  @Patch('schedules/:scheduleId')
  async updateSchedule(
    @Actor() actor: CurrentUser,
    @Param('scheduleId', new ZodPipe(UuidSchema)) scheduleId: string,
    @Body(new ZodPipe(UpdateScheduleInputSchema)) input: z.infer<typeof UpdateScheduleInputSchema>,
  ) {
    return { data: await this.controlPlane.updateSchedule(actor, scheduleId, input) };
  }

  @Post('schedules/:scheduleId/pause')
  @HttpCode(200)
  async pauseSchedule(
    @Actor() actor: CurrentUser,
    @Param('scheduleId', new ZodPipe(UuidSchema)) scheduleId: string,
    @Body(new ZodPipe(PauseScheduleInputSchema)) input: z.infer<typeof PauseScheduleInputSchema>,
  ) {
    return { data: await this.controlPlane.pauseSchedule(actor, scheduleId, input) };
  }

  @Get('devices/:deviceId/schedules/sync')
  @DeviceRoute()
  async syncSchedules(
    @DeviceActor() device: Device,
    @Param('deviceId', new ZodPipe(UuidSchema)) deviceId: string,
    @Query(new ZodPipe(ScheduleSyncQuerySchema)) input: z.infer<typeof ScheduleSyncQuerySchema>,
  ) {
    return { data: await this.controlPlane.syncSchedules(device, deviceId, input) };
  }

  @Post('runs')
  async createManualRun(
    @Actor() actor: CurrentUser,
    @Body(new ZodPipe(CreateManualRunInputSchema)) input: z.infer<typeof CreateManualRunInputSchema>,
  ) {
    return { data: await this.controlPlane.createManualRun(actor, input) };
  }

  @Get('runs')
  async listRuns(
    @Actor() actor: CurrentUser,
    @Query(new ZodPipe(ListRunsQuerySchema)) input: z.infer<typeof ListRunsQuerySchema>,
  ) {
    return { data: await this.controlPlane.listRuns(actor, input) };
  }

  @Get('runs/:runId')
  async run(@Actor() actor: CurrentUser, @Param('runId', new ZodPipe(UuidSchema)) runId: string) {
    return { data: await this.controlPlane.run(actor, runId) };
  }

  @Post('runs/:runId/cancel')
  @HttpCode(200)
  async cancelRun(@Actor() actor: CurrentUser, @Param('runId', new ZodPipe(UuidSchema)) runId: string) {
    return { data: await this.controlPlane.cancelRun(actor, runId) };
  }

  @Post('devices/:deviceId/runs/claim')
  @DeviceRoute()
  @HttpCode(200)
  async claimRuns(
    @DeviceActor() device: Device,
    @Param('deviceId', new ZodPipe(UuidSchema)) deviceId: string,
    @Body(new ZodPipe(ClaimRunsInputSchema)) input: z.infer<typeof ClaimRunsInputSchema>,
  ) {
    return { data: await this.controlPlane.claimRuns(device, deviceId, input) };
  }

  @Get('devices/:deviceId/runs/control')
  @DeviceRoute()
  async runControl(
    @DeviceActor() device: Device,
    @Param('deviceId', new ZodPipe(UuidSchema)) deviceId: string,
  ) {
    return { data: await this.controlPlane.runControl(device, deviceId) };
  }

  @Post('devices/:deviceId/runs/:runId/report')
  @DeviceRoute()
  @HttpCode(200)
  async reportRun(
    @DeviceActor() device: Device,
    @Param('deviceId', new ZodPipe(UuidSchema)) deviceId: string,
    @Param('runId', new ZodPipe(UuidSchema)) runId: string,
    @Body(new ZodPipe(ReportRunStatusInputSchema)) input: z.infer<typeof ReportRunStatusInputSchema>,
  ) {
    return { data: await this.controlPlane.reportRun(device, deviceId, runId, input) };
  }

  @Get('workspaces/:workspaceId/audit-events')
  async listAuditEvents(
    @Actor() actor: CurrentUser,
    @Param('workspaceId', new ZodPipe(UuidSchema)) workspaceId: string,
  ) {
    return { data: await this.controlPlane.listAuditEvents(actor, workspaceId) };
  }

  @Get('workspaces/:workspaceId/applications')
  async listApplications(
    @Actor() actor: CurrentUser,
    @Param('workspaceId', new ZodPipe(UuidSchema)) workspaceId: string,
  ) {
    return { data: await this.controlPlane.listApplications(actor, workspaceId) };
  }

  @Post('workspaces/:workspaceId/applications')
  async createApplication(
    @Actor() actor: CurrentUser,
    @Param('workspaceId', new ZodPipe(UuidSchema)) workspaceId: string,
    @Body(new ZodPipe(CreateApplicationInputSchema)) input: z.infer<typeof CreateApplicationInputSchema>,
  ) {
    return { data: await this.controlPlane.createApplication(actor, workspaceId, input) };
  }

  @Get('workspaces/:workspaceId/releases')
  async listReleases(
    @Actor() actor: CurrentUser,
    @Param('workspaceId', new ZodPipe(UuidSchema)) workspaceId: string,
    @Query(new ZodPipe(ListReleasesQuerySchema))
    input: z.infer<typeof ListReleasesQuerySchema>,
  ) {
    return { data: await this.controlPlane.listReleases(actor, workspaceId, input) };
  }

  @Post('applications/:applicationId/releases')
  async createRelease(
    @Actor() actor: CurrentUser,
    @Param('applicationId', new ZodPipe(UuidSchema)) applicationId: string,
    @Body(new ZodPipe(CreateReleaseInputSchema)) input: z.infer<typeof CreateReleaseInputSchema>,
  ) {
    return { data: await this.controlPlane.createRelease(actor, applicationId, input) };
  }

  @Post('releases/:releaseId/artifacts')
  async createArtifact(
    @Actor() actor: CurrentUser,
    @Param('releaseId', new ZodPipe(UuidSchema)) releaseId: string,
    @Body(new ZodPipe(CreateArtifactInputSchema)) input: z.infer<typeof CreateArtifactInputSchema>,
  ) {
    return { data: await this.controlPlane.createArtifact(actor, releaseId, input) };
  }

  @Post('artifacts/:artifactId/finalize')
  async finalizeArtifact(
    @Actor() actor: CurrentUser,
    @Param('artifactId', new ZodPipe(UuidSchema)) artifactId: string,
    @Body(new ZodPipe(FinalizeArtifactInputSchema)) input: z.infer<typeof FinalizeArtifactInputSchema>,
  ) {
    return { data: await this.controlPlane.finalizeArtifact(actor, artifactId, input) };
  }

  @Post('releases/:releaseId/submit')
  @HttpCode(200)
  async submitRelease(
    @Actor() actor: CurrentUser,
    @Param('releaseId', new ZodPipe(UuidSchema)) releaseId: string,
  ) {
    return { data: await this.controlPlane.submitRelease(actor, releaseId) };
  }

  @Get('releases/:releaseId/status')
  async releaseStatus(
    @Actor() actor: CurrentUser,
    @Param('releaseId', new ZodPipe(UuidSchema)) releaseId: string,
  ) {
    return { data: await this.controlPlane.releaseStatus(actor, releaseId) };
  }

  @Post('releases/:releaseId/reviews')
  async reviewRelease(
    @Actor() actor: CurrentUser,
    @Param('releaseId', new ZodPipe(UuidSchema)) releaseId: string,
    @Body(new ZodPipe(ReviewReleaseInputSchema)) input: z.infer<typeof ReviewReleaseInputSchema>,
  ) {
    return { data: await this.controlPlane.reviewRelease(actor, releaseId, input) };
  }

  @Get('reviews')
  async reviewQueue(
    @Actor() actor: CurrentUser,
    @Query(new ZodPipe(ListReviewQueueQuerySchema))
    input: z.infer<typeof ListReviewQueueQuerySchema>,
  ) {
    return { data: await this.controlPlane.listPendingReviews(actor, input) };
  }

  @Post('applications/:applicationId/channels/:channel/promote')
  @HttpCode(200)
  async promote(
    @Actor() actor: CurrentUser,
    @Param('applicationId', new ZodPipe(UuidSchema)) applicationId: string,
    @Param('channel', new ZodPipe(ReleaseChannelNameSchema))
    channel: z.infer<typeof ReleaseChannelNameSchema>,
    @Body(new ZodPipe(PromoteReleaseInputV1Schema)) input: z.infer<typeof PromoteReleaseInputV1Schema>,
  ) {
    return { data: await this.controlPlane.promote(actor, applicationId, channel, input) };
  }

  @Get('catalog')
  async catalog(
    @Actor() actor: CurrentUser,
    @Query(new ZodPipe(CatalogQuerySchema)) input: z.infer<typeof CatalogQuerySchema>,
  ) {
    return { data: await this.controlPlane.catalog(actor, input) };
  }

  @Public()
  @Post('internal/releases/:releaseId/validation-result')
  @HttpCode(200)
  async applyValidation(
    @Param('releaseId', new ZodPipe(UuidSchema)) releaseId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodPipe(ReleaseValidationResultSchema)) input: z.infer<typeof ReleaseValidationResultSchema>,
  ) {
    this.requireWorker(authorization);
    if (input.releaseId !== releaseId) {
      throw new DomainError(
        400,
        'release_id_mismatch',
        'Validation result releaseId must match the request path',
      );
    }
    return {
      data: await this.controlPlane.applyValidation({
        releaseId,
        success: input.success,
        artifactIds: input.artifactResults.map((result) => result.artifactId),
        releaseEvidence: input.releaseEvidence,
        artifactEvidence: Object.fromEntries(
          input.artifactResults.map((result) => [result.artifactId, result.evidence]),
        ),
      }),
    };
  }

  private requireWorker(authorization: string | undefined): void {
    const supplied = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const expected = this.config.WORKER_CALLBACK_TOKEN;
    const suppliedBytes = supplied ? Buffer.from(supplied) : Buffer.alloc(0);
    const expectedBytes = Buffer.from(expected);
    if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
      throw new DomainError(
        401,
        'worker_not_authenticated',
        'A valid worker callback credential is required',
      );
    }
  }
}
