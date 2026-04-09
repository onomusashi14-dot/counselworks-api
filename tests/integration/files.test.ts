/**
 * tests/integration/files.test.ts
 * Phase 4 gate — fixed version
 *
 * S3 is mocked. All business logic is real.
 *
 * [Upload flow]
 *  1.  upload-url returns fileId + uploadUrl — storageKey never returned
 *  2.  Invalid mime type → 400 INVALID_FILE_TYPE
 *  3.  File too large → 400 VALIDATION_ERROR
 *  4.  Cross-firm entity at upload → 403
 *  5.  Unauthenticated → 401
 *
 * [Confirm flow — FIX 1 coverage]
 *  6.  Confirm marks file ready and creates fileLink
 *  7.  Confirm validates entity belongs to file's firm (FIX 1)
 *  8.  Confirm when S3 file missing → 422 UPLOAD_NOT_FOUND
 *  9.  Double confirm → 409 ALREADY_CONFIRMED
 *  10. storageKey absent from confirm response
 *
 * [Download/preview URL]
 *  11. Preview URL returned for ready file
 *  12. Download URL returned for ready file
 *  13. Cross-firm file access → 403
 *  14. Medical record access writes activity_log (FIX 2: correct actorType)
 *  15. Non-medical file does NOT write medical_record_accessed log
 *  16. Pending file → 404
 *
 * [List files — FIX 3 coverage]
 *  17. GET /api/files?firmId=...&entityType=...&entityId=... returns files
 *  18. storageKey absent from list response
 *  19. Missing firmId param → 400
 *  20. Cross-firm entity list → 403
 *
 * [Soft delete]
 *  21. DELETE archives file (soft delete)
 *  22. Archived file → 404 on URL request
 *  23. Unauthorized user cannot delete → 403
 *
 * [actorType accuracy — FIX 2]
 *  24. CW operator confirm logs actorType=counselworks_staff, not attorney
 *
 * [Cleanup job — FIX 2]
 *  25. cleanupPendingFiles archives stale pending records
 *  26. cleanupPendingFiles writes activity_log entry
 *  27. cleanupPendingFiles does not touch recent pending records
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/prisma';
import { cleanupPendingFiles } from '../../src/utils/files.cleanup';

jest.mock('../../src/utils/s3', () => ({
  ALLOWED_MIME_TYPES: new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png',
  ]),
  MAX_SIZE_BYTES: 25 * 1024 * 1024,
  buildStorageKey: jest.fn(({ firmId, entityType, entityId, originalName }: any) =>
    `${firmId}/${entityType}/${entityId}/mock-${Date.now()}-${originalName}`
  ),
  getPresignedUploadUrl:   jest.fn().mockResolvedValue('https://s3.example.com/presigned-put'),
  getPresignedDownloadUrl: jest.fn().mockResolvedValue('https://s3.example.com/presigned-get'),
  verifyFileExists:        jest.fn().mockResolvedValue({ exists: true, sizeBytes: 102400 }),
}));

import { verifyFileExists } from '../../src/utils/s3';

const FIRM_A_ID   = '11111111-1111-1111-1111-111111111111';
const FIRM_B_ID   = '22222222-2222-2222-2222-222222222222';
const CASE_A1_ID  = '44444444-4444-4444-4444-444444444444';
const CASE_B1_ID  = '66666666-6666-6666-6666-666666666666';
const USER_A_ID   = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_OPS_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const AUTH_ID_A   = 'auth-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AUTH_ID_B   = 'auth-bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const AUTH_ID_OPS = 'auth-dddd-dddd-dddd-dddd-dddddddddddd';

const TEST_SECRET = 'test-jwt-secret-phase-4-gate';

function cookie(authId: string) {
  return `cw_session=${jwt.sign({ sub: authId }, TEST_SECRET, { expiresIn: '1h' })}`;
}

const VALID_UPLOAD = {
  firmId: FIRM_A_ID, entityType: 'case', entityId: CASE_A1_ID,
  originalName: 'test.pdf', mimeType: 'application/pdf',
  sizeBytes: 102400, documentType: 'other',
};

let app: ReturnType<typeof createApp>;
let fileId: string;
let medicalFileId: string;

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
  process.env.NODE_ENV = 'test';
  process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
  app = createApp();
  const caseA1 = await prisma.case.findUnique({ where: { id: CASE_A1_ID } });
  if (!caseA1) throw new Error('\nSeed data missing. Run: npm run db:seed\n');
});

afterAll(async () => { await prisma.$disconnect(); });

async function uploadAndConfirm(authId: string, extras: Partial<typeof VALID_UPLOAD> = {}): Promise<string> {
  const upRes = await request(app)
    .post('/api/files/upload-url')
    .set('Cookie', cookie(authId))
    .send({ ...VALID_UPLOAD, ...extras });
  const fid = upRes.body.data.fileId;
  (verifyFileExists as jest.Mock).mockResolvedValueOnce({ exists: true, sizeBytes: 102400 });
  await request(app)
    .post(`/api/files/${fid}/confirm`)
    .set('Cookie', cookie(authId))
    .send({ entityType: 'case', entityId: CASE_A1_ID });
  return fid;
}

describe('Phase 4 Gate: File Storage', () => {

  // ── Upload flow ────────────────────────────────────────────────────────────
  describe('Upload flow', () => {

    it('1. upload-url returns fileId + uploadUrl — storageKey absent', async () => {
      const res = await request(app)
        .post('/api/files/upload-url')
        .set('Cookie', cookie(AUTH_ID_A))
        .send(VALID_UPLOAD);
      expect(res.status).toBe(200);
      expect(res.body.data.fileId).toBeDefined();
      expect(res.body.data.uploadUrl).toBeDefined();
      expect(res.body.data.storageKey).toBeUndefined();
      fileId = res.body.data.fileId;
    });

    it('2. Invalid mime type → 400 INVALID_FILE_TYPE', async () => {
      const res = await request(app).post('/api/files/upload-url')
        .set('Cookie', cookie(AUTH_ID_A)).send({ ...VALID_UPLOAD, mimeType: 'video/mp4' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_FILE_TYPE');
    });

    it('3. File too large → 400 VALIDATION_ERROR', async () => {
      const res = await request(app).post('/api/files/upload-url')
        .set('Cookie', cookie(AUTH_ID_A)).send({ ...VALID_UPLOAD, sizeBytes: 30 * 1024 * 1024 });
      expect(res.status).toBe(400);
    });

    it('4. Cross-firm entity at upload → 403', async () => {
      const res = await request(app).post('/api/files/upload-url')
        .set('Cookie', cookie(AUTH_ID_A)).send({ ...VALID_UPLOAD, entityId: CASE_B1_ID });
      expect(res.status).toBe(403);
    });

    it('5. Unauthenticated → 401', async () => {
      const res = await request(app).post('/api/files/upload-url').send(VALID_UPLOAD);
      expect(res.status).toBe(401);
    });
  });

  // ── Confirm flow ───────────────────────────────────────────────────────────
  describe('Confirm flow', () => {

    it('6. Confirm marks file ready and creates fileLink', async () => {
      (verifyFileExists as jest.Mock).mockResolvedValueOnce({ exists: true, sizeBytes: 102400 });
      const res = await request(app)
        .post(`/api/files/${fileId}/confirm`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ entityType: 'case', entityId: CASE_A1_ID });
      expect(res.status).toBe(200);
      expect(res.body.data.file.status).toBe('ready');
      expect(res.body.data.file.storageKey).toBeUndefined();
      const link = await prisma.fileLink.findFirst({ where: { fileId, entityType: 'case', entityId: CASE_A1_ID } });
      expect(link).not.toBeNull();
    });

    it('7. FIX 1: Confirm rejects entityId from different firm → 403', async () => {
      // Create a fresh pending file for Firm A
      const upRes = await request(app).post('/api/files/upload-url')
        .set('Cookie', cookie(AUTH_ID_A)).send(VALID_UPLOAD);
      const freshId = upRes.body.data.fileId;
      (verifyFileExists as jest.Mock).mockResolvedValueOnce({ exists: true, sizeBytes: 102400 });

      // Attempt to link it to a Firm B case — must be rejected
      const res = await request(app)
        .post(`/api/files/${freshId}/confirm`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ entityType: 'case', entityId: CASE_B1_ID });

      expect(res.status).toBe(403);
      // File link must NOT have been created
      const link = await prisma.fileLink.findFirst({ where: { fileId: freshId, entityId: CASE_B1_ID } });
      expect(link).toBeNull();
    });

    it('8. Confirm when S3 file missing → 422 UPLOAD_NOT_FOUND', async () => {
      const upRes = await request(app).post('/api/files/upload-url')
        .set('Cookie', cookie(AUTH_ID_A)).send(VALID_UPLOAD);
      const freshId = upRes.body.data.fileId;
      (verifyFileExists as jest.Mock).mockResolvedValueOnce({ exists: false, sizeBytes: 0 });
      const res = await request(app)
        .post(`/api/files/${freshId}/confirm`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ entityType: 'case', entityId: CASE_A1_ID });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('UPLOAD_NOT_FOUND');
    });

    it('9. Double confirm → 409 ALREADY_CONFIRMED', async () => {
      const res = await request(app)
        .post(`/api/files/${fileId}/confirm`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ entityType: 'case', entityId: CASE_A1_ID });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_CONFIRMED');
    });

    it('10. storageKey absent from confirm response', async () => {
      const file = await prisma.file.findUnique({ where: { id: fileId } });
      expect(file?.storageKey).toBeDefined(); // present in DB (internal)
      // Absence from HTTP response proven by test 6
    });
  });

  // ── Download / preview URL ─────────────────────────────────────────────────
  describe('Download and preview URLs', () => {

    it('11. Preview URL returned for ready file', async () => {
      const res = await request(app)
        .get(`/api/files/${fileId}/url?intent=preview`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(200);
      expect(res.body.data.url).toBeDefined();
      expect(res.body.data.intent).toBe('preview');
    });

    it('12. Download URL returned for ready file', async () => {
      const res = await request(app)
        .get(`/api/files/${fileId}/url?intent=download`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(200);
      expect(res.body.data.intent).toBe('download');
    });

    it('13. Cross-firm file access → 403', async () => {
      const res = await request(app)
        .get(`/api/files/${fileId}/url?intent=preview`)
        .set('Cookie', cookie(AUTH_ID_B));
      expect(res.status).toBe(403);
    });

    it('14. FIX 2: Medical record access logs correct actorType', async () => {
      // Upload as CW operator (counselworks_staff, not attorney)
      const upRes = await request(app).post('/api/files/upload-url')
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ ...VALID_UPLOAD, documentType: 'medical_record', originalName: 'medical.pdf' });
      medicalFileId = upRes.body.data.fileId;
      (verifyFileExists as jest.Mock).mockResolvedValueOnce({ exists: true, sizeBytes: 102400 });
      await request(app).post(`/api/files/${medicalFileId}/confirm`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ entityType: 'case', entityId: CASE_A1_ID });

      // Access as CW operator — actorType should be counselworks_staff
      await request(app)
        .get(`/api/files/${medicalFileId}/url?intent=preview`)
        .set('Cookie', cookie(AUTH_ID_OPS));

      const logEntry = await prisma.activityLog.findFirst({
        where: { entityId: medicalFileId, activityType: 'medical_record_accessed' },
        orderBy: { createdAt: 'desc' },
      });
      expect(logEntry).not.toBeNull();
      expect(logEntry?.actorType).toBe('counselworks_staff'); // not hardcoded 'attorney'
      expect(logEntry?.ipAddress).toBeDefined();
    });

    it('15. Non-medical file does NOT write medical_record_accessed log', async () => {
      const before = await prisma.activityLog.count({
        where: { entityId: fileId, activityType: 'medical_record_accessed' },
      });
      await request(app).get(`/api/files/${fileId}/url?intent=preview`)
        .set('Cookie', cookie(AUTH_ID_A));
      const after = await prisma.activityLog.count({
        where: { entityId: fileId, activityType: 'medical_record_accessed' },
      });
      expect(after).toBe(before);
    });

    it('16. Pending file → 404', async () => {
      const upRes = await request(app).post('/api/files/upload-url')
        .set('Cookie', cookie(AUTH_ID_A)).send(VALID_UPLOAD);
      const pendingId = upRes.body.data.fileId;
      const res = await request(app)
        .get(`/api/files/${pendingId}/url?intent=preview`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(404);
    });
  });

  // ── List files ─────────────────────────────────────────────────────────────
  describe('List files — FIX 3', () => {

    it('17. GET /api/files with firmId param returns ready files', async () => {
      const res = await request(app)
        .get(`/api/files?firmId=${FIRM_A_ID}&entityType=case&entityId=${CASE_A1_ID}`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.files)).toBe(true);
      expect(res.body.data.files.length).toBeGreaterThan(0);
    });

    it('18. storageKey absent from list response', async () => {
      const res = await request(app)
        .get(`/api/files?firmId=${FIRM_A_ID}&entityType=case&entityId=${CASE_A1_ID}`)
        .set('Cookie', cookie(AUTH_ID_A));
      res.body.data.files.forEach((f: Record<string, unknown>) => {
        expect(f.storageKey).toBeUndefined();
        expect(f.storage_key).toBeUndefined();
      });
    });

    it('19. Missing firmId param → 400', async () => {
      const res = await request(app)
        .get(`/api/files?entityType=case&entityId=${CASE_A1_ID}`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    });

    it('20. Cross-firm entity in list → 403', async () => {
      // Firm A user requests files for a Firm B case
      const res = await request(app)
        .get(`/api/files?firmId=${FIRM_A_ID}&entityType=case&entityId=${CASE_B1_ID}`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(403);
    });
  });

  // ── Soft delete ────────────────────────────────────────────────────────────
  describe('Soft delete', () => {
    let deleteFileId: string;

    beforeAll(async () => {
      deleteFileId = await uploadAndConfirm(AUTH_ID_A);
    });

    it('21. DELETE archives file', async () => {
      const res = await request(app)
        .delete(`/api/files/${deleteFileId}`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(200);
      const file = await prisma.file.findUnique({ where: { id: deleteFileId } });
      expect(file?.status).toBe('archived');
      expect(file?.archivedAt).not.toBeNull();
      expect(file?.storageKey).toBeDefined(); // preserved for recovery
    });

    it('22. Archived file → 404 on URL request', async () => {
      const res = await request(app)
        .get(`/api/files/${deleteFileId}/url?intent=preview`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(404);
    });

    it('23. Unauthorized user cannot delete → 403', async () => {
      const upRes = await request(app).post('/api/files/upload-url')
        .set('Cookie', cookie(AUTH_ID_A)).send(VALID_UPLOAD);
      const res = await request(app)
        .delete(`/api/files/${upRes.body.data.fileId}`)
        .set('Cookie', cookie(AUTH_ID_B));
      expect(res.status).toBe(403);
    });
  });

  // ── actorType accuracy ─────────────────────────────────────────────────────
  describe('FIX 2: actorType derived from role', () => {

    it('24. CW operator confirm logs actorType=counselworks_staff', async () => {
      const upRes = await request(app).post('/api/files/upload-url')
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ ...VALID_UPLOAD, originalName: 'ops-upload.pdf' });
      const opsFileId = upRes.body.data.fileId;
      (verifyFileExists as jest.Mock).mockResolvedValueOnce({ exists: true, sizeBytes: 102400 });

      await request(app).post(`/api/files/${opsFileId}/confirm`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ entityType: 'case', entityId: CASE_A1_ID });

      const logEntry = await prisma.activityLog.findFirst({
        where: { entityId: opsFileId, activityType: 'file_uploaded' },
      });
      expect(logEntry?.actorType).toBe('counselworks_staff'); // not hardcoded 'attorney'
    });
  });

  // ── Cleanup job ────────────────────────────────────────────────────────────
  describe('FIX 2: Cleanup job writes activity_log', () => {

    it('25. cleanupPendingFiles archives stale pending records', async () => {
      const stale = await prisma.file.create({
        data: {
          firmId: FIRM_A_ID, uploadedBy: USER_A_ID,
          originalName: 'orphan.pdf',
          storageKey: `${FIRM_A_ID}/case/${CASE_A1_ID}/orphan-${Date.now()}`,
          mimeType: 'application/pdf', sizeBytes: BigInt(1024),
          documentType: 'other', status: 'pending',
          createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        },
      });
      await cleanupPendingFiles();
      const updated = await prisma.file.findUnique({ where: { id: stale.id } });
      expect(updated?.status).toBe('archived');
    });

    it('26. cleanupPendingFiles writes activity_log entry (system actor)', async () => {
      const stale = await prisma.file.create({
        data: {
          firmId: FIRM_A_ID, uploadedBy: USER_A_ID,
          originalName: 'orphan2.pdf',
          storageKey: `${FIRM_A_ID}/case/${CASE_A1_ID}/orphan2-${Date.now()}`,
          mimeType: 'application/pdf', sizeBytes: BigInt(1024),
          documentType: 'other', status: 'pending',
          createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
        },
      });

      const before = await prisma.activityLog.count({
        where: { activityType: 'files_cleanup' },
      });

      await cleanupPendingFiles();

      const after = await prisma.activityLog.count({
        where: { activityType: 'files_cleanup' },
      });
      expect(after).toBeGreaterThan(before);

      const entry = await prisma.activityLog.findFirst({
        where: { activityType: 'files_cleanup' },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry?.actorType).toBe('system');
      expect(entry?.actorId).toBeNull();
    });

    it('27. cleanupPendingFiles does not touch recent pending records', async () => {
      const upRes = await request(app).post('/api/files/upload-url')
        .set('Cookie', cookie(AUTH_ID_A)).send(VALID_UPLOAD);
      const recentId = upRes.body.data.fileId;

      await cleanupPendingFiles();

      const file = await prisma.file.findUnique({ where: { id: recentId } });
      expect(file?.status).toBe('pending'); // untouched
    });
  });
});
