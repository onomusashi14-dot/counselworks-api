/**
 * src/modules/cases/cases.router.ts
 *
 * Phase 2: Cases + Activity Log
 *
 * Routes:
 *   GET  /firms/:firmId/cases              List cases (role-filtered)
 *   GET  /firms/:firmId/cases/:caseId      Case detail
 *   PATCH /firms/:firmId/cases/:caseId     Update phase, status, priority
 *   GET  /firms/:firmId/cases/:caseId/activity  Activity timeline
 *
 * Role filtering:
 *   attorney → only cases where primary_attorney_id = req.user.id
 *   all other firm roles → all non-archived cases for the firm
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { authenticate } from '../../middleware/authenticate';
import { requireFirmAccess } from '../../middleware/requireFirmAccess';
import { requireRole } from '../../middleware/requireRole';
import { logActivity } from '../../utils/auditLog';

export const casesRouter = Router({ mergeParams: true });

// ─── VALID VALUES ─────────────────────────────────────────────────────────────────
const PHASES = [
  'intake','administration','records_collection',
  'demand_prep','negotiation','litigation_prep','litigation','resolved',
] as const;

const STATUSES = ['active','on_hold','closed','settled','archived'] as const;
const PRIORITIES = ['normal','high','urgent'] as const;

// ─── VALIDATION SCHEMAS ─────────────────────────────────────────────────────────
const CaseUpdateSchema = z.object({
  phase:    z.enum(PHASES).optional(),
  status:   z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  notes:    z.string().max(5000).optional(),
}).strict();

const CaseListQuerySchema = z.object({
  phase:    z.enum(PHASES).optional(),
  status:   z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  page:     z.coerce.number().int().min(1).default(1),
  limit:    z.coerce.number().int().min(1).max(100).default(25),
});

// ─── LIST CASES ───────────────────────────────────────────────────────────────
casesRouter.get(
  '/',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { firmId, role } = req.firmContext!;

      const query = CaseListQuerySchema.safeParse(req.query);
      if (!query.success) {
        res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid query parameters.', details: query.error.flatten() },
        });
        return;
      }

      const { phase, status, priority, page, limit } = query.data;
      const skip = (page - 1) * limit;

      // Role filter: attorneys only see their assigned cases
      const roleFilter =
        role === 'attorney'
          ? { primaryAttorneyId: req.user!.id }
          : {};

      const where = {
        firmId,
        archivedAt: null,
        ...roleFilter,
        ...(phase    ? { phase }    : {}),
        ...(status   ? { status }   : { status: { not: 'archived' } as const }),
        ...(priority ? { priority } : {}),
      };

      const [cases, total] = await Promise.all([
        prisma.case.findMany({
          where,
          select: {
            id: true,
            matterNumber: true,
            clientName: true,
            caseType: true,
            jurisdiction: true,
            phase: true,
            status: true,
            priority: true,
            readinessScore: true,
            assignedCwUserId: true,
            primaryAttorneyId: true,
            openedDate: true,
            createdAt: true,
          },
          orderBy: [
            { priority: 'desc' },
            { createdAt: 'desc' },
          ],
          skip,
          take: limit,
        }),
        prisma.case.count({ where }),
      ]);

      res.status(200).json({
        ok: true,
        data: { cases },
        meta: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (err) {
      console.error('[CASES LIST]', err);
      res.status(500).json({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to list cases.' },
      });
    }
  }
);

// ─── CASE DETAIL ──────────────────────────────────────────────────────────────
casesRouter.get(
  '/:caseId',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { firmId, role } = req.firmContext!;
      const { caseId } = req.params;

      const caseRecord = await prisma.case.findFirst({
        where: {
          id: caseId,
          firmId,            // firm isolation enforced at query level too
          archivedAt: null,
        },
      });

      if (!caseRecord) {
        // 403 not 404 — we never confirm existence across firm boundaries
        res.status(403).json({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
        });
        return;
      }

      // Attorney role: can only see their own cases
      if (role === 'attorney' && caseRecord.primaryAttorneyId !== req.user!.id) {
        res.status(403).json({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
        });
        return;
      }

      // Log case access for audit trail
      await logActivity({
        firmId,
        actorId: req.user!.id,
        actorType: role.startsWith('counselworks') ? 'counselworks_staff' : 'attorney',
        entityType: 'case',
        entityId: caseId,
        activityType: 'case_viewed',
        description: `${req.user!.fullName} viewed case ${caseRecord.matterNumber}`,
        ipAddress: req.ip,
      });

      res.status(200).json({ ok: true, data: { case: caseRecord } });
    } catch (err) {
      console.error('[CASE DETAIL]', err);
      res.status(500).json({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch case detail.' },
      });
    }
  }
);

// ─── UPDATE CASE ──────────────────────────────────────────────────────────────
casesRouter.patch(
  '/:caseId',
  authenticate,
  requireFirmAccess(),
  requireRole('counselworks_admin', 'counselworks_operator'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { firmId } = req.firmContext!;
      const { caseId } = req.params;

      const body = CaseUpdateSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid request body.', details: body.error.flatten() },
        });
        return;
      }

      // Verify case belongs to this firm
      const existing = await prisma.case.findFirst({
        where: { id: caseId, firmId, archivedAt: null },
        select: { id: true, matterNumber: true, phase: true, status: true, priority: true },
      });

      if (!existing) {
        res.status(403).json({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
        });
        return;
      }

      const updates = body.data;
      if (Object.keys(updates).length === 0) {
        res.status(400).json({
          ok: false,
          error: { code: 'NO_CHANGES', message: 'No fields to update.' },
        });
        return;
      }

      const updated = await prisma.case.update({
        where: { id: caseId },
        data: updates,
      });

      // Build a plain-language description of what changed
      const changes: string[] = [];
      if (updates.phase    && updates.phase    !== existing.phase)    changes.push(`phase → ${updates.phase}`);
      if (updates.status   && updates.status   !== existing.status)   changes.push(`status → ${updates.status}`);
      if (updates.priority && updates.priority !== existing.priority) changes.push(`priority → ${updates.priority}`);

      if (changes.length > 0) {
        await logActivity({
          firmId,
          actorId: req.user!.id,
          actorType: 'counselworks_staff',
          entityType: 'case',
          entityId: caseId,
          activityType: 'case_updated',
          description: `${req.user!.fullName} updated ${existing.matterNumber}: ${changes.join(', ')}`,
          ipAddress: req.ip,
          metadata: { previous: { phase: existing.phase, status: existing.status, priority: existing.priority }, updates },
        });
      }

      res.status(200).json({ ok: true, data: { case: updated } });
    } catch (err) {
      console.error('[CASE UPDATE]', err);
      res.status(500).json({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update case.' },
      });
    }
  }
);

// ─── ACTIVITY TIMELINE ────────────────────────────────────────────────────────
casesRouter.get(
  '/:caseId/activity',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { firmId, role } = req.firmContext!;
      const { caseId } = req.params;

      // Verify case belongs to this firm and is accessible
      const caseRecord = await prisma.case.findFirst({
        where: { id: caseId, firmId, archivedAt: null },
        select: { id: true, primaryAttorneyId: true, matterNumber: true },
      });

      if (!caseRecord) {
        res.status(403).json({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
        });
        return;
      }

      // Attorney role: only their own cases
      if (role === 'attorney' && caseRecord.primaryAttorneyId !== req.user!.id) {
        res.status(403).json({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
        });
        return;
      }

      const page  = Math.max(1, parseInt(req.query.page as string ?? '1', 10));
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string ?? '50', 10)));
      const skip  = (page - 1) * limit;

      const [entries, total] = await Promise.all([
        prisma.activityLog.findMany({
          where: { entityType: 'case', entityId: caseId },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          select: {
            id: true,
            actorType: true,
            actorId: true,
            activityType: true,
            description: true,
            createdAt: true,
            metadata: true,
            // Never return ip_address to clients
          },
        }),
        prisma.activityLog.count({
          where: { entityType: 'case', entityId: caseId },
        }),
      ]);

      res.status(200).json({
        ok: true,
        data: { activity: entries },
        meta: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (err) {
      console.error('[CASE ACTIVITY]', err);
      res.status(500).json({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch activity log.' },
      });
    }
  }
);
