import { z } from 'zod';

import {
  PublisherSignatureSchema,
  ReleaseManifestSchema,
  Sha256Schema,
} from '@awesome-workflow/manifest-schema';

import { SbomDescriptorSchema, ValidationEvidenceSchema } from './control-plane.js';

export const DownloadableSbomSchema = SbomDescriptorSchema.extend({ url: z.string().url() });

export const ReleaseValidationQueueName = 'release-validation' as const;
export const ReleaseValidationJobName = 'release.validate' as const;
export const ReleaseValidationJobSchema = z.object({
  releaseId: z.string().uuid(),
  manifest: ReleaseManifestSchema,
  artifacts: z.array(
    z.object({
      artifactId: z.string().uuid(),
      fileName: z.string().min(1).max(240),
      url: z.string().url(),
      expectedSha256: Sha256Schema,
      expectedSize: z.number().int().positive(),
      signature: PublisherSignatureSchema,
      sbom: DownloadableSbomSchema,
    }),
  ),
});
export type ReleaseValidationJob = z.infer<typeof ReleaseValidationJobSchema>;
export const ReleaseValidationResultSchema = z
  .object({
    releaseId: z.string().uuid(),
    success: z.boolean(),
    artifactResults: z.array(
      z.object({
        artifactId: z.string().uuid(),
        success: z.boolean(),
        actualSha256: Sha256Schema.optional(),
        actualSize: z.number().int().nonnegative().optional(),
        error: z.string().max(500).optional(),
        evidence: z.array(ValidationEvidenceSchema),
      }),
    ),
    releaseEvidence: z.array(ValidationEvidenceSchema),
  })
  .superRefine((value, context) => {
    if (value.success !== value.artifactResults.every((artifact) => artifact.success)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['success'],
        message: 'Release success must match the aggregate artifact result',
      });
    }
  });
export type ReleaseValidationResult = z.infer<typeof ReleaseValidationResultSchema>;
