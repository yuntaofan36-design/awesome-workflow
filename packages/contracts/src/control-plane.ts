import { z } from 'zod';

import {
  ApplicationSlugSchema,
  PublisherSignatureSchema,
  ReleaseManifestSchema,
  SemanticVersionSchema,
  Sha256Schema,
} from '@awesome-workflow/manifest-schema';

import { ApplicationLocalizationsSchema, SupportedLocaleSchema } from './locale.js';

export const ApplicationKindSchema = z.enum(['web', 'desktop']);
export type ApplicationKind = z.infer<typeof ApplicationKindSchema>;
export const ReleaseChannelNameSchema = z.enum(['dev', 'canary', 'stable']);
export type ReleaseChannelName = z.infer<typeof ReleaseChannelNameSchema>;
export const ReleaseStatusSchema = z.enum([
  'draft',
  'uploading',
  'validating',
  'ready',
  'approved',
  'rejected',
]);
export type ReleaseStatus = z.infer<typeof ReleaseStatusSchema>;
export const ArtifactStatusSchema = z.enum(['pending_upload', 'uploaded', 'validated', 'rejected']);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const ApplicationSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  slug: ApplicationSlugSchema,
  name: z.string().min(2).max(80),
  summary: z.string().max(240),
  defaultLocale: SupportedLocaleSchema.default('en-US'),
  localizations: ApplicationLocalizationsSchema,
  kind: ApplicationKindSchema,
  createdAt: z.string().datetime(),
});
export type Application = z.infer<typeof ApplicationSchema>;
export const CreateApplicationInputSchema = ApplicationSchema.pick({
  slug: true,
  name: true,
  summary: true,
  defaultLocale: true,
  localizations: true,
  kind: true,
});
export type CreateApplicationInput = z.infer<typeof CreateApplicationInputSchema>;

export const SbomDescriptorSchema = z.object({
  format: z.enum(['cyclonedx-json', 'spdx-json']),
  fileName: z
    .string()
    .min(1)
    .max(240)
    .refine((value) => !value.includes('/') && !value.includes('\\')),
  mediaType: z.enum(['application/vnd.cyclonedx+json', 'application/spdx+json']),
  sha256: Sha256Schema,
});
export type SbomDescriptor = z.infer<typeof SbomDescriptorSchema>;

export const ValidationEvidenceSchema = z.object({
  id: z.string().uuid(),
  validator: z.string().min(1).max(120),
  check: z.enum(['manifest', 'csp', 'digest', 'signature', 'sbom', 'archive', 'platform', 'permissions']),
  outcome: z.enum(['passed', 'failed']),
  observedAt: z.string().datetime(),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type ValidationEvidence = z.infer<typeof ValidationEvidenceSchema>;

export const ReleaseSchema = z.object({
  id: z.string().uuid(),
  applicationId: z.string().uuid(),
  version: SemanticVersionSchema,
  manifest: ReleaseManifestSchema,
  manifestSha256: Sha256Schema,
  signature: PublisherSignatureSchema,
  sbom: SbomDescriptorSchema,
  validationEvidence: z.array(ValidationEvidenceSchema),
  status: ReleaseStatusSchema,
  createdBy: z.string().uuid(),
  createdAt: z.string().datetime(),
});
export type Release = z.infer<typeof ReleaseSchema>;
export const ListReleasesQuerySchema = z.object({
  applicationId: z.string().uuid().optional(),
  status: ReleaseStatusSchema.optional(),
  kind: ApplicationKindSchema.optional(),
});
export type ListReleasesQuery = z.infer<typeof ListReleasesQuerySchema>;
export const CreateReleaseInputSchema = z.object({
  version: SemanticVersionSchema,
  manifest: ReleaseManifestSchema,
  signature: PublisherSignatureSchema,
  sbom: SbomDescriptorSchema,
});
export type CreateReleaseInput = z.infer<typeof CreateReleaseInputSchema>;

export const CreateArtifactInputSchema = z.object({
  fileName: z
    .string()
    .min(1)
    .max(240)
    .refine((value) => !value.includes('/') && !value.includes('\\')),
  contentType: z.string().min(1).max(120),
  size: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 * 1024 * 1024),
  sha256: Sha256Schema,
  signature: PublisherSignatureSchema,
  sbom: SbomDescriptorSchema,
});
export type CreateArtifactInput = z.infer<typeof CreateArtifactInputSchema>;
export const ArtifactSchema = CreateArtifactInputSchema.extend({
  id: z.string().uuid(),
  releaseId: z.string().uuid(),
  storageKey: z.string().min(1),
  sbomStorageKey: z.string().min(1),
  status: ArtifactStatusSchema,
  validationEvidence: z.array(ValidationEvidenceSchema),
  createdAt: z.string().datetime(),
  finalizedAt: z.string().datetime().optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;
export const UploadIntentSchema = z.object({
  artifact: ArtifactSchema,
  upload: z.object({
    method: z.literal('PUT'),
    url: z.string().url(),
    headers: z.record(z.string()),
    expiresAt: z.string().datetime(),
  }),
  sbomUpload: z.object({
    method: z.literal('PUT'),
    url: z.string().url(),
    headers: z.record(z.string()),
    expiresAt: z.string().datetime(),
  }),
});
export type UploadIntent = z.infer<typeof UploadIntentSchema>;
export const FinalizeArtifactInputSchema = z.object({ etag: z.string().min(1).max(256).optional() });
export type FinalizeArtifactInput = z.infer<typeof FinalizeArtifactInputSchema>;

export const ReviewReleaseInputSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().max(1000).default(''),
});
export type ReviewReleaseInput = z.infer<typeof ReviewReleaseInputSchema>;
export const PromoteReleaseInputV1Schema = z.object({
  releaseId: z.string().uuid(),
  expectedCurrentReleaseId: z.string().uuid().nullable().optional(),
});
export type PromoteReleaseInputV1 = z.infer<typeof PromoteReleaseInputV1Schema>;

export const ReleaseReviewSchema = z.object({
  id: z.string().uuid(),
  releaseId: z.string().uuid(),
  decision: z.enum(['approve', 'reject']),
  comment: z.string(),
  reviewerId: z.string().uuid(),
  createdAt: z.string().datetime(),
});
export type ReleaseReview = z.infer<typeof ReleaseReviewSchema>;
export const ReleaseStatusViewSchema = z.object({
  release: ReleaseSchema,
  artifacts: z.array(ArtifactSchema),
  reviews: z.array(ReleaseReviewSchema),
});
export type ReleaseStatusView = z.infer<typeof ReleaseStatusViewSchema>;
export const ReleaseListItemSchema = z.object({
  application: ApplicationSchema,
  release: ReleaseSchema,
  artifactCount: z.number().int().nonnegative(),
  reviewCount: z.number().int().nonnegative(),
});
export type ReleaseListItem = z.infer<typeof ReleaseListItemSchema>;
export const ListReviewQueueQuerySchema = z.object({
  workspaceId: z.string().uuid(),
  kind: ApplicationKindSchema.optional(),
});
export type ListReviewQueueQuery = z.infer<typeof ListReviewQueueQuerySchema>;

export const CatalogEntrySchema = z.object({
  applicationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  slug: ApplicationSlugSchema,
  name: z.string(),
  summary: z.string(),
  defaultLocale: SupportedLocaleSchema.default('en-US'),
  localizations: ApplicationLocalizationsSchema,
  kind: ApplicationKindSchema,
  releaseId: z.string().uuid(),
  version: SemanticVersionSchema,
  channel: ReleaseChannelNameSchema,
  manifest: ReleaseManifestSchema,
  promotedAt: z.string().datetime(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
