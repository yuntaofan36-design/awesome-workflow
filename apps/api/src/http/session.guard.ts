import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { DomainError } from '../core/errors.js';
import { PLATFORM_REPOSITORY, type PlatformRepository } from '../core/repository.js';
import { AuthService } from '../modules/auth/auth.service.js';
import type { DeviceAuthenticatedRequest } from './device-actor.decorator.js';
import { deviceCredential, hashDeviceCredential } from './device-auth.js';
import { REQUIRES_DEVICE_AUTH } from './device-route.decorator.js';
import { IS_PUBLIC } from './public.decorator.js';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PLATFORM_REPOSITORY) private readonly repository: PlatformRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const metadataTargets = [context.getHandler(), context.getClass()];
    const request = context.switchToHttp().getRequest<DeviceAuthenticatedRequest>();
    if (this.reflector.getAllAndOverride<boolean>(REQUIRES_DEVICE_AUTH, metadataTargets)) {
      const credential = deviceCredential(request.headers.authorization);
      const device = credential
        ? await this.repository.findActiveDeviceByCredentialHash(hashDeviceCredential(credential))
        : null;
      if (!device) {
        throw new DomainError(
          401,
          'device_not_authenticated',
          'A valid active device credential is required',
        );
      }
      request.currentDevice = device;
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, metadataTargets)) return true;
    const token = bearerToken(request.headers.authorization) ?? cookieToken(request.headers.cookie);
    const user = await this.auth.current(token);
    if (!user) throw new DomainError(401, 'not_authenticated', 'Authentication is required');
    request.currentUser = user;
    return true;
  }
}

export function bearerToken(value: string | string[] | undefined): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  const match = header?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1];
}

export function cookieToken(value: string | string[] | undefined): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  return header
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([name]) => name === 'aw_session')?.[1];
}
