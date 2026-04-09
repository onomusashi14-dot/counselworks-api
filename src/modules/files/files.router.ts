/**
 * src/modules/files/files.router.ts
 * Phase 4 — fixed version
 *
 * Fixes applied:
 *   1. confirm endpoint validates entityType/entityId belongs to file.firmId
 *      before creating fileLink — prevents cross-entity file linking
 *   2. actorType derived from user's role, never hardcoded
 *   3. GET /api/files uses explicit firmId from query, not requireFirmAccess()
 *      (requireFirmAccess requires a :firmId route param — this route has none)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { authenticate } from '../../middleware/authenticate';
import { logActivity } from '../../utils/auditLog';
import {
  ALLOWED_MIME_TYPES,
  MAX_SIZE_BYTES,
  buildStorageKey,
  getPresignedUploadUrl,
  getPresignedDownloadUrl,
  verifyFileExists,
} from '../../utils/s3';

export const filesRouter = Router();

// ─── MEDICAL RECORD TYPES — every URL generation is logged ───────────────────
const MEDICAL_TYPES = new Set(['medical_record', 'billing_record']);

const ENTITY_TYPES = ['case', 'request', 'message'] as const;
type EntityType = typeof ENTITY_TYPES[number];

// ─── actorType derived from role — never hardcoded ───────────────────────────
function actorTypeFromRole(role: string): 'attorney' | 'firm_staff' | 'counselworks_staff' {
  if (role === 'managing_attorney' || role === 'attorney') return 'attorney';
  if (role === 'firm_admin' || role === 'case_manager')    return 'firm_staff';
  return 'counselworks_staff';
}

// ─── FIRM ACCESS HELPER ───────────────────────────────────────────────────────
// Used in routes that have no :firmId param (upload-url, confirm, url, delete).
// Returns the user's role in the given firm, or null if no access.
async function getUserRoleInFirm(
  userId: string,
  firmId: string
): Promise<string | null> {
  const membership = await prisma.firmMembership.findUnique({
    where: { firmId_userId: { firmId, userId } },
    select: { role: true, archivedAt: true },
  });

  if (membership && !membership.archivedAt) return membership.role;

  // Check global admin access
  const globalAdmin = await prisma.firmMembership.findFirst({
    where: { userId, role: 'counselworks_admin', archivedAt: null },
    select: { role: true },
  });

  return globalAdmin?.role ?? null;
}

// ─── ENTITY OWNERSHIP VALIDATION ─────────────────────────────────────────────
// Verifies entity belongs to firmId before creating a file_link.
// Non-negotiable: prevents cross-firm file linking.
async function verifyEntityBelongsToFirm(
  entityType: EntityType,
  entityId: string,
  firmId: string
): Promise<boolean> {
  if (entityType === 'case') {
    const c = await prisma.case.findFirst({
      where: { id: entityId, firmId, archivedAt: null },
      select: { id: true },
    });
    return !!c;
  }
  if (entityType === 'request') {
    const r = await prisma.request.findFirst({
      where: { id: entityId, firmId },
      select: { id: true },
    });
    return !!r;
  }
  if (entityType === 'message') {
    const m = await prisma.requestMessage.findFirst({
      where: { id: entityId, firmId },
      select: { id: true },
    });
    return !!m;
  }
  return false;
}

// ─── SCHEMAS ──────────────────────────────────────────────────────────────────
const UploadUrlSchema = z.object({
  firmId:       z.string().uuid(),
  entityType:   z.enum(ENTITY_TYPES),
  entityId:     z.string().uuid(),
  originalName: z.string().min(1).max(255),
  mimeType:     z.string(),
  sizeBytes:    z.number().int().positive().max(MAX_SIZE_BYTES),
  documentType: z.enum([
    'id', 'insurance', 'police_report', 'medical_record', 'billing_record',
    'photo', 'retainer', 'demand_draft', 'medical_summary', 'chronology',
    'carrier_correspondence', 'other',
  ]).default('other'),
}).strict();

const ConfirmSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId:   z.string().uuid(),
}).strict();

// ─── STEP 1: REQUEST PRESIGNED UPLOAD URL ────────────────────────────────────
filesRouter.post(
  '/upload-url',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UploadUrlSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request body.', details: parsed.error.flatten() },
      });
      return;
    }

    const { firmId, entityType, entityId, originalName, mimeType, sizeBytes, documentType } = parsed.data;

    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      res.status(400).json({
        ok: false,
        error: { code: 'INVALID_FILE_TYPE', message: 'File type not allowed. Accepted: PDF, DOC, DOCX, JPG, PNG.' },
      });
      return;
    }

    // Verify user has access to this firm
    const role = await getUserRoleInFirm(req.user!.id, firmId);
    if (!role) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    // Verify entity belongs to this firm
    const entityValid = await verifyEntityBelongsToFirm(entityType, entityId, firmId);
    if (!entityValid) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    const storageKey = buildStorageKey({ firmId, entityType, entityId, originalName });

    const file = await prisma.file.create({
      data: {
        firmId,
        uploadedBy:   req.user!.id,
        originalName,
        storageKey,
        mimeType,
        sizeBytes:    BigInt(sizeBytes),
        documentType,
        status:       'pending',
        reviewStatus: 'unreviewed',
      },
    });

    const uploadUrl = await getPresignedUploadUrl({ storageKey, mimeType, sizeBytes });
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // storageKey NEVER returned to client
    res.status(200).json({
      ok: true,
      data: { fileId: file.id, uploadUrl, expiresAt },
    });
  }
);

// ─── STEP 3: CONFIRM UPLOAD COMPLETE ─────────────────────────────────────────
filesRouter.post(
  '/:fileId/confirm',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const { fileId } = req.params;

    const parsed = ConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request body.', details: parsed.error.flatten() },
      });
      return;
    }

    const { entityType, entityId } = parsed.data;

    const file = await prisma.file.findUnique({
      where: { id: fileId },
      select: {
        id: true, firmId: true, uploadedBy: true,
        storageKey: true, originalName: true,
        mimeType: true, sizeBytes: true,
        documentType: true, status: true,
      },
    });

    if (!file) {
      res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'File record not found.' },
      });
      return;
    }

    // Verify caller has access to this file's firm
    const role = await getUserRoleInFirm(req.user!.id, file.firmId);
    if (!role) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    // Only uploader or CW admin/operator can confirm
    const canConfirm =
      file.uploadedBy === req.user!.id ||
      role === 'counselworks_admin' ||
      role === 'counselworks_operator';

    if (!canConfirm) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    if (file.status !== 'pending') {
      res.status(409).json({
        ok: false,
        error: { code: 'ALREADY_CONFIRMED', message: 'File has already been confirmed.' },
      });
      return;
    }

    // ── FIX 1: Validate entity belongs to file's firm BEFORE creating fileLink ─
    // This is the critical gap — prevents cross-firm file linking.
    const entityValid = await verifyEntityBelongsToFirm(entityType, entityId, file.firmId);
    if (!entityValid) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    // Verify file actually landed in S3
    const { exists, sizeBytes: actualSize } = await verifyFileExists(file.storageKey);
    if (!exists) {
      res.status(422).json({
        ok: false,
        error: { code: 'UPLOAD_NOT_FOUND', message: 'File not found in storage. Upload may have failed — please try again.' },
      });
      return;
    }

    // Mark ready + create fileLink in transaction
    const [updatedFile] = await prisma.$transaction([
      prisma.file.update({
        where: { id: fileId },
        data: {
          status:    'ready',
          sizeBytes: BigInt(actualSize) || file.sizeBytes,
        },
        select: {
          id: true, firmId: true, originalName: true,
          mimeType: true, sizeBytes: true, documentType: true,
          status: true, reviewStatus: true, createdAt: true,
          // storageKey intentionally excluded
        },
      }),
      prisma.fileLink.create({
        data: { firmId: file.firmId, fileId: file.id, entityType, entityId },
      }),
    ]);

    // FIX 2: actorType derived from role, not hardcoded
    await logActivity({
      firmId:       file.firmId,
      actorId:      req.user!.id,
      actorType:    actorTypeFromRole(role),
      entityType:   'file',
      entityId:     file.id,
      activityType: 'file_uploaded',
      description:  `${req.user!.fullName} uploaded "${file.originalName}"`,
      ipAddress:    req.ip,
      metadata:     { documentType: file.documentType, entityType, entityId },
    });

    res.status(200).json({
      ok: true,
      data: { file: { ...updatedFile, sizeBytes: updatedFile.sizeBytes.toString() } },
    });
  }
);

// ─── GET PRESIGNED DOWNLOAD/PREVIEW URL ──────────────────────────────────────
filesRouter.get(
  '/:fileId/url',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const { fileId } = req.params;
    const intent = req.query.intent === 'download' ? 'download' : 'preview';

    const file = await prisma.file.findUnique({
      where: { id: fileId },
      select: {
        id: true, firmId: true, storageKey: true,
        originalName: true, mimeType: true,
        documentType: true, status: true, archivedAt: true,
      },
    });

    if (!file || file.status !== 'ready' || file.archivedAt !== null) {
      res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'File not found.' },
      });
      return;
    }

    // Firm isolation — hard stop
    const role = await getUserRoleInFirm(req.user!.id, file.firmId);
    if (!role) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    // Medical record: log BEFORE generating URL — captures the attempt
    if (MEDICAL_TYPES.has(file.documentType)) {
      await logActivity({
        firmId:       file.firmId,
        actorId:      req.user!.id,
        actorType:    actorTypeFromRole(role),   // FIX 2: not hardcoded
        entityType:   'file',
        entityId:     file.id,
        activityType: 'medical_record_accessed',
        description:  `${req.user!.fullName} accessed medical record "${file.originalName}" (${intent})`,
        ipAddress:    req.ip,
        metadata:     { intent, documentType: file.documentType },
      });
    }

    const url = await getPresignedDownloadUrl({
      storageKey:   file.storageKey,
      originalName: file.originalName,
      intent,
    });

    const expiresAt = new Date(
      Date.now() + (intent === 'download' ? 5 : 15) * 60 * 1000
    ).toISOString();

    res.status(200).json({ ok: true, data: { url, expiresAt, intent } });
  }
);

// ─── FIX 3: LIST FILES — explicit firmId from query, not requireFirmAccess() ─
// requireFirmAccess() requires :firmId in route params — this route has none.
// firmId is validated from query param + user's membership instead.
filesRouter.get(
  '/',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const { entityType, entityId, firmId } = req.query as {
      entityType?: string;
      entityId?: string;
      firmId?: string;
    };

    if (!firmId || !entityType || !entityId || !ENTITY_TYPES.includes(entityType as EntityType)) {
      res.status(400).json({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'firmId, entityType, and entityId query params are required.' },
      });
      return;
    }

    // Validate user access to this firm
    const role = await getUserRoleInFirm(req.user!.id, firmId);
    if (!role) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    // Validate entity belongs to this firm
    const entityValid = await verifyEntityBelongsToFirm(entityType as EntityType, entityId, firmId);
    if (!entityValid) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    const links = await prisma.fileLink.findMany({
      where: { firmId, entityType, entityId },
      include: {
        file: {
          select: {
            id: true, originalName: true, mimeType: true,
            sizeBytes: true, documentType: true,
            status: true, reviewStatus: true,
            createdAt: true, uploadedBy: true,
            // storageKey intentionally excluded
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const files = links
      .filter(l => l.file.status === 'ready')
      .map(l => ({
        ...l.file,
        sizeBytes: l.file.sizeBytes.toString(),
        linkId:    l.id,
        linkedAt:  l.createdAt,
      }));

    res.status(200).json({ ok: true, data: { files } });
  }
);

// ─── SOFT DELETE ──────────────────────────────────────────────────────────────
filesRouter.delete(
  '/:fileId',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const { fileId } = req.params;

    const file = await prisma.file.findUnique({
      where: { id: fileId },
      select: { id: true, firmId: true, uploadedBy: true, originalName: true, status: true },
    });

    if (!file || file.status === 'archived') {
      res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'File not found.' },
      });
      return;
    }

    const role = await getUserRoleInFirm(req.user!.id, file.firmId);
    if (!role) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    const canDelete =
      file.uploadedBy === req.user!.id ||
      role === 'counselworks_admin' ||
      role === 'counselworks_operator';

    if (!canDelete) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    await prisma.file.update({
      where: { id: fileId },
      data: { status: 'archived', archivedAt: new Date() },
    });

    await logActivity({
      firmId:       file.firmId,
      actorId:      req.user!.id,
      actorType:    actorTypeFromRole(role),   // FIX 2: derived from role
      entityType:   'file',
      entityId:     file.id,
      activityType: 'file_archived',
      description:  `${req.user!.fullName} archived file "${file.originalName}"`,
      ipAddress:    req.ip,
    });

    res.status(200).json({ ok: true, data: { archived: true } });
  }
);
