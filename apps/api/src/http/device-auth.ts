import { createHash, randomBytes } from 'node:crypto';

import { DeviceCredentialSchema, type DeviceCredential } from '@awesome-workflow/contracts';

const DEVICE_CREDENTIAL_PREFIX = 'awd_';

export function issueDeviceCredential(): DeviceCredential {
  return DeviceCredentialSchema.parse(`${DEVICE_CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`);
}

export function hashDeviceCredential(credential: DeviceCredential): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}

export function deviceCredential(value: string | string[] | undefined): DeviceCredential | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  const supplied = header?.match(/^Device\s+([^\s]+)$/i)?.[1];
  if (!supplied) return undefined;
  const parsed = DeviceCredentialSchema.safeParse(supplied);
  return parsed.success ? parsed.data : undefined;
}
