import type { PlatformConfig } from '@awesome-workflow/config';

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export type StoredObjectDeclaration = {
  key: string;
  contentType: string;
  sha256: string;
  size?: number;
};

export type SignedUpload = {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
};

export type SignedDownload = {
  url: string;
  expiresAt: string;
};

export interface ObjectStoragePort {
  createUpload(declaration: StoredObjectDeclaration): Promise<SignedUpload>;
  /** Private service-to-service URL. It must never be returned to a device. */
  createWorkerDownload(key: string): Promise<SignedDownload>;
  /** Browser/device reachable URL. It must never use Compose-only DNS. */
  createDeviceDownload(key: string): Promise<SignedDownload>;
  assertUploaded(declaration: StoredObjectDeclaration): Promise<void>;
}

export class MemoryObjectStorageAdapter implements ObjectStoragePort {
  constructor(private readonly config: PlatformConfig) {}

  async createUpload(declaration: StoredObjectDeclaration): Promise<SignedUpload> {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    return {
      method: 'PUT',
      url: objectUrl(this.config.ARTIFACT_UPLOAD_BASE_URL, declaration.key),
      headers: {
        'content-type': declaration.contentType,
        'x-content-sha256': declaration.sha256,
      },
      expiresAt,
    };
  }

  async createWorkerDownload(key: string): Promise<SignedDownload> {
    return this.createMemoryDownload(key);
  }

  async createDeviceDownload(key: string): Promise<SignedDownload> {
    return this.createMemoryDownload(key);
  }

  private createMemoryDownload(key: string): SignedDownload {
    return {
      url: objectUrl(this.config.ARTIFACT_UPLOAD_BASE_URL, key),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
  }

  async assertUploaded(_declaration: StoredObjectDeclaration): Promise<void> {
    // This adapter is intentionally limited to tests and contract development.
  }
}

function objectUrl(base: string, key: string): string {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return new URL(encodedKey, normalizedBase).toString();
}
