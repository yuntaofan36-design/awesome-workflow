import { SetMetadata } from '@nestjs/common';

export const REQUIRES_DEVICE_AUTH = 'requiresDeviceAuth';
export const DeviceRoute = () => SetMetadata(REQUIRES_DEVICE_AUTH, true);
