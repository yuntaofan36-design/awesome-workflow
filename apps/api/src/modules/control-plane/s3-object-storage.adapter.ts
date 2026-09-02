import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { PlatformConfig } from '@awesome-workflow/config';

import { DomainError } from '../../core/errors.js';
import type {
  ObjectStoragePort,
  SignedDownload,
  SignedUpload,
  StoredObjectDeclaration,
} from './object-storage.port.js';

const UPLOAD_EXPIRY_SECONDS = 10 * 60;
const DOWNLOAD_EXPIRY_SECONDS = 60 * 60;

export class S3ObjectStorageAdapter implements ObjectStoragePort {
  private readonly internalClient: S3Client;
  private readonly publicClient: S3Client;

  constructor(private readonly config: PlatformConfig) {
    const common = {
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID!,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
      },
    };
    this.internalClient = new S3Client({ ...common, endpoint: config.S3_ENDPOINT! });
    this.publicClient = new S3Client({ ...common, endpoint: config.S3_PUBLIC_ENDPOINT! });
  }

  async createUpload(declaration: StoredObjectDeclaration): Promise<SignedUpload> {
    const checksum = hexToBase64(declaration.sha256);
    const command = new PutObjectCommand({
      Bucket: this.config.S3_BUCKET,
      Key: declaration.key,
      ContentType: declaration.contentType,
      ChecksumSHA256: checksum,
      Metadata: { 'aw-sha256': declaration.sha256 },
    });
    const url = await getSignedUrl(this.publicClient, command, { expiresIn: UPLOAD_EXPIRY_SECONDS });
    return {
      method: 'PUT',
      url,
      headers: {
        'content-type': declaration.contentType,
        'x-amz-checksum-sha256': checksum,
        'x-amz-meta-aw-sha256': declaration.sha256,
      },
      expiresAt: new Date(Date.now() + UPLOAD_EXPIRY_SECONDS * 1000).toISOString(),
    };
  }

  async createDownload(key: string): Promise<SignedDownload> {
    const url = await getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }),
      { expiresIn: DOWNLOAD_EXPIRY_SECONDS },
    );
    return {
      url,
      expiresAt: new Date(Date.now() + DOWNLOAD_EXPIRY_SECONDS * 1000).toISOString(),
    };
  }

  async assertUploaded(declaration: StoredObjectDeclaration): Promise<void> {
    try {
      const result = await this.internalClient.send(
        new HeadObjectCommand({
          Bucket: this.config.S3_BUCKET,
          Key: declaration.key,
          ChecksumMode: 'ENABLED',
        }),
      );
      if (declaration.size !== undefined && result.ContentLength !== declaration.size) {
        throw new DomainError(
          409,
          'object_size_mismatch',
          'Uploaded object size differs from its immutable declaration',
        );
      }
      if (result.ContentType !== declaration.contentType) {
        throw new DomainError(
          409,
          'object_content_type_mismatch',
          'Uploaded object content type differs from its declaration',
        );
      }
      const expectedChecksum = hexToBase64(declaration.sha256);
      if (result.ChecksumSHA256 && result.ChecksumSHA256 !== expectedChecksum) {
        throw new DomainError(
          409,
          'object_checksum_mismatch',
          'Uploaded object checksum differs from its immutable declaration',
        );
      }
      if (result.Metadata?.['aw-sha256'] !== declaration.sha256) {
        throw new DomainError(
          409,
          'object_metadata_mismatch',
          'Uploaded object is missing its signed digest metadata',
        );
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        409,
        'object_not_uploaded',
        'The uploaded object could not be verified in object storage',
      );
    }
  }
}

function hexToBase64(value: string): string {
  return Buffer.from(value, 'hex').toString('base64');
}
