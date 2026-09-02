import { z } from 'zod';

export const ProblemDetailsSchema = z.object({
  type: z.string().url(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  errors: z.unknown().optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
