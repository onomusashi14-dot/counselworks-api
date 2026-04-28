/**
 * src/modules/requests/leads.router.ts
 *
 * Leads = Requests that have NOT been linked to a case yet (caseId IS NULL).
 * These represent pre-case intake — potential clients who haven't been converted.
 *
 * Routes:
 *   GET  /firms/:firmId/leads              List leads (requests with no caseId)
 *   GET  /firms/:firmId/leads/:leadId      Lead detail (same as request detail)
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../../config/prisma';
import { authenticate } from '../../middleware/authenticate';
import { requireFirmAccess } from '../../middleware/requireFirmAccess';

export const leadsRouter = Router({ mergeParams: true });

const LEAD_STATUSES = ['open', 'in_progress', 'pending_attorney', 'completed', 'closed'] as const;

// ─── LIST LEADS ──────────────────────────────────────────────────────────────
leadsRouter.get(
  '/',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;

    const page  = Math.max(1, parseInt(req.query.page  as string ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string ?? '25', 10)));
    const skip  = (page - 1) * limit;

    const statusFilter = req.query.status as string | undefined;
    const validStatus  = LEAD_STATUSES.includes(statusFilter as any) ? statusFilter : undefined;

    const where = {
      firmId,
      caseId: null,  // Leads = requests not yet linked to a case
      ...(validStatus ? { status: validStatus } : {}),
    };

    const [leads, total] = await Promise.all([
      prisma.request.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id:          true,
          firmId:      true,
          caseId:      true,
          createdBy:   true,
          assignedTo:  true,
          subject:     true,
          requestType: true,
          status:      true,
          slaDueAt:    true,
          eta:         true,
          createdAt:   true,
          closedAt:    true,
        },
      }),
      prisma.request.count({ where }),
    ]);

    res.status(200).json({
      ok: true,
      data: { leads },
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  }
);

// ─── LEAD DETAIL ─────────────────────────────────────────────────────────────
leadsRouter.get(
  '/:leadId',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;
    const { leadId } = req.params;

    const lead = await prisma.request.findFirst({
      where: { id: leadId, firmId, caseId: null },
      select: {
        id:          true,
        firmId:      true,
        caseId:      true,
        createdBy:   true,
        assignedTo:  true,
        subject:     true,
        requestType: true,
        status:      true,
        slaDueAt:    true,
        eta:         true,
        createdAt:   true,
        closedAt:    true,
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            id:             true,
            senderId:       true,
            senderType:     true,
            body:           true,
            isDraftDelivery: true,
            createdAt:      true,
          },
        },
      },
    });

    if (!lead) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    res.status(200).json({ ok: true, data: { lead } });
  }
);
