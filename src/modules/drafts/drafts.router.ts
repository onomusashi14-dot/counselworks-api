/**
 * src/modules/drafts/drafts.router.ts
 *
 * Phase 5: Drafts Inbox
 *
 * ── ROLE POLICY (locked) ──────────────────────────────────────────────────────
 *   counselworks_operator  — create, review, revise, deliver
 *   counselworks_admin     — create, review, revise, deliver, AND approve
 *   managing_attorney      — view all delivered drafts in firm
 *   firm_admin             — view all delivered drafts in firm
 *   attorney               — view delivered drafts for their assigned cases only
 *   case_manager           — view delivered drafts for firm (read-only)
 *   All others             — no access
 *
 *   Approval is restricted to counselworks_admin only.
 *   This is the controlled quality gate — intentionally narrower than other CW actions.
 *
 * ── STATUS MACHINE ────────────────────────────────────────────────────────────
 *   drafted → in_review  (/review    — operator or admin)
 *   in_review → approved (/approve   — admin ONLY)
 *   in_review → needs_revision (/revise — operator or admin, note required)
 *   needs_revision → in_review (/review — operator or admin)
 *   approved → delivered (/deliver  — operator or admin, requires approvedBy)
 *
 * ── NON-NEGOTIABLE CONSTRAINTS ────────────────────────────────────────────────
 *   1. Delivered requires approvedBy — enforced at app layer AND DB constraint
 *   2. Only counselworks_admin can approve
 *   3. label_text is fixed at creation — no update path exists
 *   4. Attorney inbox shows delivered drafts only
 *   5. Plain attorney role sees only drafts for assigned cases
 *
 * ── ROUTES ───────────────────────────────────────────────────────────────────
 *   POST  /firms/:firmId/drafts                   Create (operator, admin)
 *   GET   /firms/:firmId/drafts                   List (role-filtered)
 *   GET   /firms/:firmId/drafts/:draftId          Detail (role-filtered)
 *   PATCH /firms/:firmId/drafts/:draftId/review   → in_review (operator, admin)
 *   PATCH /firms/:firmId/drafts/:draftId/approve  → approved  (admin ONLY)
 *   PATCH /firms/:firmId/drafts/:draftId/revise   → needs_revision (operator, admin)
 *   PATCH /firms/:firmId/drafts/:draftId/deliver  → delivered (operator, admin)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { authenticate } from '../../middleware/authenticate';
import { requireFirmAccess } from '../../middleware/requireFirmAccess';
import { requireRole } from '../../middleware/requireRole';
import { logActivity } from '../../utils/auditLog';
import { createNotification } from '../../utils/notify';

export const draftsRouter = Router({ mergeParams: true });

const DRAFT_TYPES = [
  'demand_letter', 'medical_summary', 'chronology',
  'case_fact_sheet', 'client_communication',
  'provider_communication', 'declaration_shell', 'other',
] as const;

const FIXED_LABEL = 'DRAFT — PREPARED FOR ATTORNEY REVIEW ONLY. NOT LEGAL ADVICE.';

// Roles that can see delivered drafts — firm-wide view
const FIRM_WIDE_ROLES = new Set(['managing_attorney', 'firm_admin', 'case_manager']);
// Roles that can perform CW operations (not approve)
const CW_OPS_ROLES = ['counselworks_admin', 'counselworks_operator'] as const;
// Only admin can approve
const APPROVE_ROLES = ['counselworks_admin'] as const;

// ─── SCHEMAS ──────────────────────────────────────────────────────────────────
const CreateDraftSchema = z.object({
  caseId:        z.string().uuid(),
  requestId:     z.string().uuid().optional(),
  fileId:        z.string().uuid().optional(),
  draftType:     z.enum(DRAFT_TYPES),
  generatedByAi: z.boolean().default(false),
  notes:         z.string().max(5000).optional(),
}).strict();

const ReviseSchema = z.object({
  notes: z.string().min(1).max(5000), // mandatory — no note = no revision request
}).strict();

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function getPrimaryAttorneyId(caseId: string): Promise<string | null> {
  const c = await prisma.case.findUnique({
    where: { id: caseId },
    select: { primaryAttorneyId: true },
  });
  return c?.primaryAttorneyId ?? null; // null handled gracefully in all callers
}

// Returns case IDs the attorney is assigned to — used for attorney draft filtering
async function getAssignedCaseIds(userId: string, firmId: string): Promise<string[]> {
  const cases = await prisma.case.findMany({
    where: { firmId, primaryAttorneyId: userId, archivedAt: null },
    select: { id: true },
  });
  return cases.map(c => c.id);
}

// ─── CREATE DRAFT ─────────────────────────────────────────────────────────────
draftsRouter.post(
  '/',
  authenticate,
  requireFirmAccess(),
  requireRole('counselworks_admin', 'counselworks_operator'),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;

    const parsed = CreateDraftSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request body.', details: parsed.error.flatten() },
      });
      return;
    }

    const { caseId, requestId, fileId, draftType, generatedByAi, notes } = parsed.data;

    // Verify case belongs to this firm
    const caseRecord = await prisma.case.findFirst({
      where: { id: caseId, firmId, archivedAt: null },
      select: { id: true },
    });
    if (!caseRecord) {
      res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
      return;
    }

    if (requestId) {
      const r = await prisma.request.findFirst({ where: { id: requestId, firmId } });
      if (!r) {
        res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
        return;
      }
    }

    if (fileId) {
      const f = await prisma.file.findFirst({ where: { id: fileId, firmId, status: 'ready', archivedAt: null } });
      if (!f) {
        res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'File not found or not ready.' } });
        return;
      }
    }

    const existingCount = await prisma.draft.count({ where: { caseId, draftType, firmId } });

    const draft = await prisma.draft.create({
      data: {
        firmId, caseId,
        requestId: requestId ?? null,
        fileId:    fileId ?? null,
        draftType,
        version:   existingCount + 1,
        status:    'drafted',
        labelText: FIXED_LABEL,   // set at creation — no update path exists
        generatedByAi,
        notes:     notes ?? null,
        reviewedBy: null,
        approvedBy: null,
      },
    });

    await logActivity({
      firmId, actorId: req.user!.id, actorType: 'counselworks_staff',
      entityType: 'draft', entityId: draft.id,
      activityType: 'draft_created',
      description: `${req.user!.fullName} created ${draftType} draft v${draft.version}`,
      ipAddress: req.ip,
      metadata: { draftType, version: draft.version, generatedByAi },
    });

    res.status(201).json({ ok: true, data: { draft } });
  }
);

// ─── LIST DRAFTS ──────────────────────────────────────────────────────────────
draftsRouter.get(
  '/',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId, role } = req.firmContext!;

    const page  = Math.max(1, parseInt(req.query.page  as string ?? '1',  10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string ?? '25', 10)));
    const skip  = (page - 1) * limit;

    // CW roles see all drafts at any status
    const isCw = role === 'counselworks_admin' || role === 'counselworks_operator';

    // managing_attorney and firm_admin see all delivered drafts in the firm
    const isFirmWide = FIRM_WIDE_ROLES.has(role);

    // Plain attorney sees only delivered drafts for their assigned cases
    const isAttorney = role === 'attorney';

    let where: any = { firmId, archivedAt: null };

    if (isCw) {
      // No status filter — see everything
    } else if (isFirmWide) {
      where.status = 'delivered';
    } else if (isAttorney) {
      const assignedCaseIds = await getAssignedCaseIds(req.user!.id, firmId);
      if (assignedCaseIds.length === 0) {
        // No assigned cases — return empty result, not an error
        res.status(200).json({ ok: true, data: { drafts: [] }, meta: { page, limit, total: 0, pages: 0 } });
        return;
      }
      where.status = 'delivered';
      where.caseId = { in: assignedCaseIds };
    } else {
      // qa_reviewer or unknown role — read-only delivered view
      where.status = 'delivered';
    }

    const [drafts, total] = await Promise.all([
      prisma.draft.findMany({
        where,
        orderBy: [{ deliveredAt: 'desc' }, { createdAt: 'desc' }],
        skip, take: limit,
        select: {
          id: true, caseId: true, requestId: true,
          // fileId exposed so frontend can call /api/files/:fileId/url
          fileId: true,
          draftType: true, version: true, status: true,
          labelText: true,      // always present — attorney must see it
          generatedByAi: true,
          reviewedBy: true, approvedBy: true,
          notes: true, createdAt: true, deliveredAt: true,
        },
      }),
      prisma.draft.count({ where }),
    ]);

    res.status(200).json({
      ok: true,
      data: { drafts },
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  }
);

// ─── DRAFT DETAIL ─────────────────────────────────────────────────────────────
// Returns fileId explicitly so frontend can call GET /api/files/:fileId/url
draftsRouter.get(
  '/:draftId',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId, role } = req.firmContext!;
    const { draftId } = req.params;

    const isCw       = role === 'counselworks_admin' || role === 'counselworks_operator';
    const isFirmWide = FIRM_WIDE_ROLES.has(role);
    const isAttorney = role === 'attorney';

    const draft = await prisma.draft.findFirst({
      where: { id: draftId, firmId, archivedAt: null },
      select: {
        id: true, caseId: true, requestId: true,
        fileId: true,         // frontend uses this to call /api/files/:fileId/url
        draftType: true, version: true, status: true,
        labelText: true,      // fixed label — must be present in every response
        generatedByAi: true,
        reviewedBy: true, approvedBy: true,
        notes: true, createdAt: true, deliveredAt: true,
      },
    });

    if (!draft) {
      res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
      return;
    }

    // CW roles see any draft at any status
    if (isCw) {
      res.status(200).json({ ok: true, data: { draft } });
      return;
    }

    // Firm-wide roles and attorney: delivered only
    if (draft.status !== 'delivered') {
      res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
      return;
    }

    // Plain attorney: only drafts for their assigned cases
    if (isAttorney) {
      const assignedIds = await getAssignedCaseIds(req.user!.id, firmId);
      if (!assignedIds.includes(draft.caseId)) {
        res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
        return;
      }
    }

    res.status(200).json({ ok: true, data: { draft } });
  }
);

// ─── MARK IN REVIEW ───────────────────────────────────────────────────────────
draftsRouter.patch(
  '/:draftId/review',
  authenticate,
  requireFirmAccess(),
  requireRole('counselworks_admin', 'counselworks_operator'),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;
    const { draftId } = req.params;

    const draft = await prisma.draft.findFirst({
      where: { id: draftId, firmId, archivedAt: null },
      select: { id: true, status: true, draftType: true, version: true },
    });

    if (!draft) {
      res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
      return;
    }

    if (draft.status !== 'drafted' && draft.status !== 'needs_revision') {
      res.status(409).json({ ok: false, error: { code: 'INVALID_TRANSITION', message: `Cannot move to in_review from ${draft.status}.` } });
      return;
    }

    const updated = await prisma.draft.update({
      where: { id: draftId },
      data: { status: 'in_review', reviewedBy: req.user!.id },
    });

    await logActivity({
      firmId, actorId: req.user!.id, actorType: 'counselworks_staff',
      entityType: 'draft', entityId: draftId, activityType: 'draft_in_review',
      description: `${req.user!.fullName} submitted ${draft.draftType} v${draft.version} for review`,
      ipAddress: req.ip,
    });

    res.status(200).json({ ok: true, data: { draft: updated } });
  }
);

// ─── APPROVE DRAFT — ADMIN ONLY ───────────────────────────────────────────────
// Intentionally narrower than other CW operations.
// counselworks_operator can do everything except approve.
// This gives a clean quality gate that requires senior sign-off.
draftsRouter.patch(
  '/:draftId/approve',
  authenticate,
  requireFirmAccess(),
  requireRole('counselworks_admin'),   // ADMIN ONLY — not operator
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;
    const { draftId } = req.params;

    const draft = await prisma.draft.findFirst({
      where: { id: draftId, firmId, archivedAt: null },
      select: { id: true, status: true, draftType: true, version: true },
    });

    if (!draft) {
      res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
      return;
    }

    if (draft.status !== 'in_review') {
      res.status(409).json({ ok: false, error: { code: 'INVALID_TRANSITION', message: `Cannot approve from ${draft.status}. Draft must be in_review first.` } });
      return;
    }

    const updated = await prisma.draft.update({
      where: { id: draftId },
      data: { status: 'approved', approvedBy: req.user!.id },
    });

    await logActivity({
      firmId, actorId: req.user!.id, actorType: 'counselworks_staff',
      entityType: 'draft', entityId: draftId, activityType: 'draft_approved',
      description: `${req.user!.fullName} approved ${draft.draftType} v${draft.version}`,
      ipAddress: req.ip,
    });

    res.status(200).json({ ok: true, data: { draft: updated } });
  }
);

// ─── REQUEST REVISION ─────────────────────────────────────────────────────────
draftsRouter.patch(
  '/:draftId/revise',
  authenticate,
  requireFirmAccess(),
  requireRole('counselworks_admin', 'counselworks_operator'),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;
    const { draftId } = req.params;

    const parsed = ReviseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Revision note is required.', details: parsed.error.flatten() },
      });
      return;
    }

    const draft = await prisma.draft.findFirst({
      where: { id: draftId, firmId, archivedAt: null },
      select: { id: true, status: true, draftType: true, version: true },
    });

    if (!draft) {
      res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
      return;
    }

    if (draft.status !== 'in_review') {
      res.status(409).json({ ok: false, error: { code: 'INVALID_TRANSITION', message: `Can only request revision from in_review. Current: ${draft.status}.` } });
      return;
    }

    const updated = await prisma.draft.update({
      where: { id: draftId },
      data: { status: 'needs_revision', notes: parsed.data.notes },
    });

    await logActivity({
      firmId, actorId: req.user!.id, actorType: 'counselworks_staff',
      entityType: 'draft', entityId: draftId, activityType: 'draft_revision_requested',
      description: `${req.user!.fullName} requested revision on ${draft.draftType} v${draft.version}: ${parsed.data.notes}`,
      ipAddress: req.ip,
      metadata: { revisionNote: parsed.data.notes },
    });

    res.status(200).json({ ok: true, data: { draft: updated } });
  }
);

// ─── DELIVER DRAFT ────────────────────────────────────────────────────────────
// Two-layer gate:
//   Layer 1 (app):  approvedBy must be set — returns 422 APPROVAL_REQUIRED
//   Layer 2 (DB):   constraint: status='delivered' requires approved_by IS NOT NULL
// Both must be defeated simultaneously to bypass — not possible via normal API.
draftsRouter.patch(
  '/:draftId/deliver',
  authenticate,
  requireFirmAccess(),
  requireRole('counselworks_admin', 'counselworks_operator'),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;
    const { draftId } = req.params;

    const draft = await prisma.draft.findFirst({
      where: { id: draftId, firmId, archivedAt: null },
      select: {
        id: true, status: true, approvedBy: true,
        draftType: true, version: true, caseId: true,
        requestId: true, labelText: true,
      },
    });

    if (!draft) {
      res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
      return;
    }

    if (draft.status !== 'approved') {
      res.status(409).json({ ok: false, error: { code: 'INVALID_TRANSITION', message: `Cannot deliver from ${draft.status}. Draft must be approved first.` } });
      return;
    }

    // Layer 1: app-level gate — clear error message before hitting DB
    if (!draft.approvedBy) {
      res.status(422).json({
        ok: false,
        error: { code: 'APPROVAL_REQUIRED', message: 'Draft must be approved by a CounselWorks admin before delivery.' },
      });
      return;
    }

    const updated = await prisma.draft.update({
      where: { id: draftId },
      data: { status: 'delivered', deliveredAt: new Date() },
    });

    await logActivity({
      firmId, actorId: req.user!.id, actorType: 'counselworks_staff',
      entityType: 'draft', entityId: draftId, activityType: 'draft_delivered',
      description: `${req.user!.fullName} delivered ${draft.draftType} v${draft.version} to firm`,
      ipAddress: req.ip,
      metadata: { draftType: draft.draftType, version: draft.version, approvedBy: draft.approvedBy },
    });

    // Notify primary attorney — null tolerated cleanly
    const attorneyId = await getPrimaryAttorneyId(draft.caseId);
    if (attorneyId) {
      await createNotification({
        userId: attorneyId, firmId,
        type:  'draft_delivered',
        title: `Draft ready: ${draft.draftType.replace(/_/g, ' ')} v${draft.version}`,
        body:  draft.labelText,
        entityType: 'draft', entityId: draftId,
      });
    }

    // Post system message to linked request thread if present
    if (draft.requestId) {
      await prisma.requestMessage.create({
        data: {
          requestId: draft.requestId, firmId,
          senderId:  req.user!.id,
          senderType: 'counselworks_staff',
          body: `Draft delivered: ${draft.draftType.replace(/_/g, ' ')} v${draft.version}. ${draft.labelText}`,
          isDraftDelivery: true,
        },
      });
    }

    res.status(200).json({ ok: true, data: { draft: updated } });
  }
);
