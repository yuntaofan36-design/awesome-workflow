import { z } from 'zod';

import {
  ApplicationSlugSchema,
  DesktopCapabilitySchema,
  DesktopReleaseManifestSchema,
  PublisherSignatureSchema,
  SemanticVersionSchema,
  Sha256Schema,
  WebCapabilitySchema,
} from '@awesome-workflow/manifest-schema';

const SlugSchema = ApplicationSlugSchema;
const VersionSchema = SemanticVersionSchema;
const HttpUrlSchema = z
  .string()
  .url()
  .refine((url) => /^https?:/.test(url), 'Expected an HTTP(S) URL');

export const ReleaseChannelSchema = z.enum(['dev', 'canary', 'stable']);
export type ReleaseChannel = z.infer<typeof ReleaseChannelSchema>;

export const WebRuntimeSchema = z.enum(['federation', 'iframe', 'link']);
export type WebRuntime = z.infer<typeof WebRuntimeSchema>;

export { DesktopCapabilitySchema, WebCapabilitySchema };
export type WebCapability = z.infer<typeof WebCapabilitySchema>;

export const WebAppSchema = z.object({
  id: z.string().uuid(),
  slug: SlugSchema,
  name: z.string().min(2).max(80),
  summary: z.string().max(240),
  runtime: WebRuntimeSchema,
  trust: z.enum(['trusted', 'sandboxed']),
  capabilities: z.array(WebCapabilitySchema),
  activeRelease: z
    .object({
      id: z.string().uuid(),
      version: VersionSchema,
      entryUrl: HttpUrlSchema,
      channel: ReleaseChannelSchema,
      integritySha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      createdAt: z.string().datetime(),
    })
    .nullable(),
  createdAt: z.string().datetime(),
});
export type WebApp = z.infer<typeof WebAppSchema>;

export const CreateWebAppInputSchema = WebAppSchema.pick({
  slug: true,
  name: true,
  summary: true,
  runtime: true,
  trust: true,
  capabilities: true,
}).superRefine((value, context) => {
  if (value.runtime === 'federation' && value.trust !== 'trusted') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Federation runtimes execute in the shell and must be explicitly trusted',
      path: ['trust'],
    });
  }
});
export type CreateWebAppInput = z.infer<typeof CreateWebAppInputSchema>;

export const PublishWebReleaseInputSchema = z.object({
  version: VersionSchema,
  entryUrl: HttpUrlSchema,
  integritySha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  channel: ReleaseChannelSchema.default('dev'),
});
export type PublishWebReleaseInput = z.infer<typeof PublishWebReleaseInputSchema>;

export type DesktopCapability = z.infer<typeof DesktopCapabilitySchema>;

export const DesktopManifestSchema = DesktopReleaseManifestSchema;
export type DesktopManifest = z.infer<typeof DesktopManifestSchema>;

export const DesktopAppSchema = z.object({
  id: z.string().uuid(),
  slug: SlugSchema,
  name: z.string().min(2).max(80),
  summary: z.string().max(240),
  activeRelease: z
    .object({
      id: z.string().uuid(),
      version: VersionSchema,
      artifactUrl: HttpUrlSchema,
      sha256: Sha256Schema,
      signature: PublisherSignatureSchema,
      channel: ReleaseChannelSchema,
      manifest: DesktopManifestSchema,
      createdAt: z.string().datetime(),
    })
    .nullable(),
  createdAt: z.string().datetime(),
});
export type DesktopApp = z.infer<typeof DesktopAppSchema>;

export const CreateDesktopAppInputSchema = DesktopAppSchema.pick({
  slug: true,
  name: true,
  summary: true,
});
export type CreateDesktopAppInput = z.infer<typeof CreateDesktopAppInputSchema>;

export const PublishDesktopReleaseInputSchema = z.object({
  artifactUrl: HttpUrlSchema,
  sha256: Sha256Schema,
  signature: PublisherSignatureSchema,
  channel: ReleaseChannelSchema.default('dev'),
  manifest: DesktopManifestSchema,
});
export type PublishDesktopReleaseInput = z.infer<typeof PublishDesktopReleaseInputSchema>;

export const PromoteReleaseInputSchema = z.object({
  releaseId: z.string().uuid(),
  channel: ReleaseChannelSchema,
});
export type PromoteReleaseInput = z.infer<typeof PromoteReleaseInputSchema>;
