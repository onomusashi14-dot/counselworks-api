/**
 * src/utils/s3.ts
 *
 * S3 operations for CounselWorks file storage.
 *
 * Rules enforced here:
 * - Private bucket only — no public URLs ever
 * - All access via presigned URLs with short expiry
 * - Storage key format: {firmId}/{entityType}/{entityId}/{uuid}-{sanitized-name}
 * - Never return a storage key to the client — only file IDs
 *
 * Requires env vars:
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *   AWS_REGION
 *   S3_BUCKET_NAME
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

// ─── CLIENT ───────────────────────────────────────────────────────────────────
export const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-west-2',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  },
});

export const BUCKET = process.env.S3_BUCKET_NAME ?? 'counselworks-files-dev';

// ─── ALLOWED MIME TYPES ───────────────────────────────────────────────────────
export const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
]);

export const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

// ─── STORAGE KEY ──────────────────────────────────────────────────────────────
// Format: {firmId}/{entityType}/{entityId}/{uuid}-{sanitized-filename}
// firmId prefix enables bucket-level policy enforcement per firm
export function buildStorageKey(params: {
  firmId: string;
  entityType: string;
  entityId: string;
  originalName: string;
}): string {
  const { firmId, entityType, entityId, originalName } = params;
  const uuid = randomUUID();
  // Sanitize: lowercase, replace non-alphanumeric (except . and -) with -
  const safe = originalName
    .toLowerCase()
    .replace(/[^a-z0-9.\-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100);
  return `${firmId}/${entityType}/${entityId}/${uuid}-${safe}`;
}

// ─── PRESIGNED PUT (upload) ───────────────────────────────────────────────────
// 15-minute expiry — client uploads directly to S3 after receiving this URL
export async function getPresignedUploadUrl(params: {
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<string> {
  const { storageKey, mimeType, sizeBytes } = params;

  const command = new PutObjectCommand({
    Bucket:        BUCKET,
    Key:           storageKey,
    ContentType:   mimeType,
    ContentLength: sizeBytes,
    // Enforce private ACL at object level — belt-and-suspenders
    ACL: 'private' as const,
  });

  return getSignedUrl(s3, command, { expiresIn: 15 * 60 }); // 15 minutes
}

// ─── PRESIGNED GET (download/preview) ────────────────────────────────────────
// preview: inline — browser renders in-tab
// download: attachment — browser saves file
export async function getPresignedDownloadUrl(params: {
  storageKey: string;
  originalName: string;
  intent: 'preview' | 'download';
}): Promise<string> {
  const { storageKey, originalName, intent } = params;

  const disposition = intent === 'download'
    ? `attachment; filename="${encodeURIComponent(originalName)}"`
    : 'inline';

  const expiry = intent === 'download' ? 5 * 60 : 15 * 60; // 5min download, 15min preview

  const command = new GetObjectCommand({
    Bucket:                     BUCKET,
    Key:                        storageKey,
    ResponseContentDisposition: disposition,
  });

  return getSignedUrl(s3, command, { expiresIn: expiry });
}

// ─── VERIFY EXISTS ────────────────────────────────────────────────────────────
// Called after client confirms upload — verifies file actually landed in S3
export async function verifyFileExists(storageKey: string): Promise<{ exists: boolean; sizeBytes: number }> {
  try {
    const response = await s3.send(new HeadObjectCommand({
      Bucket: BUCKET,
      Key:    storageKey,
    }));
    return {
      exists:    true,
      sizeBytes: response.ContentLength ?? 0,
    };
  } catch {
    return { exists: false, sizeBytes: 0 };
  }
}

// ─── SOFT DELETE (archive) ────────────────────────────────────────────────────
// We soft-delete in the DB first. S3 object remains for recovery.
// Hard delete from S3 is a separate scheduled cleanup job (not Phase 4).
export async function archiveS3Object(_storageKey: string): Promise<void> {
  // Phase 4: mark archived in DB only.
  // Physical S3 deletion is a Phase 5 scheduled cleanup job.
  // This function is a placeholder to keep the interface consistent.
}
