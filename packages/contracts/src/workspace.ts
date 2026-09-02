import { z } from 'zod';

/** Roles are scoped to exactly one workspace. Review authority is platform-scoped. */
export const WorkspaceRoleSchema = z.enum(['owner', 'admin', 'developer', 'member']);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

/** Platform roles never imply membership in, or access to, a workspace. */
export const PlatformRoleSchema = z.enum(['platform_admin', 'official_reviewer']);
export type PlatformRole = z.infer<typeof PlatformRoleSchema>;

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  slug: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  name: z.string().min(2).max(80),
  role: WorkspaceRoleSchema,
  createdAt: z.string().datetime(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const CreateWorkspaceInputSchema = WorkspaceSchema.pick({ slug: true, name: true });
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>;
