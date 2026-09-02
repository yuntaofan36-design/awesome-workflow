import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { CurrentUser } from '@awesome-workflow/contracts';

export type AuthenticatedRequest = {
  currentUser?: CurrentUser;
  headers: Record<string, string | string[] | undefined>;
  url: string;
};

export const Actor = createParamDecorator((_data: unknown, context: ExecutionContext): CurrentUser => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.currentUser) throw new Error('Actor decorator used without authentication');
  return request.currentUser;
});
