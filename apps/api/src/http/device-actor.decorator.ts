import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Device } from '@awesome-workflow/contracts';

import type { AuthenticatedRequest } from './actor.decorator.js';

export type DeviceAuthenticatedRequest = AuthenticatedRequest & { currentDevice?: Device };

export const DeviceActor = createParamDecorator((_data: unknown, context: ExecutionContext): Device => {
  const request = context.switchToHttp().getRequest<DeviceAuthenticatedRequest>();
  if (!request.currentDevice) throw new Error('DeviceActor decorator used without device authentication');
  return request.currentDevice;
});
