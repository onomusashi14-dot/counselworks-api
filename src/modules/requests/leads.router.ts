/**
 * src/modules/requests/leads.router.ts
 *
 * Leads represent potential clients who haven't been converted to cases yet.
 * Uses the Lead model (linked to Client for contact info).
 *
 * Routes:
 *   GET  /firms/:firmId/leads              List leads
 *   GET  /firms/:firmId/leads/:leadId      Lead detail
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../../config/prisma';
import { authenticate } from '../../middleware/authenticate';
import { requireFirmAccess } from '../../middleware/requireFirmAccess';

export const leadsRouter = Router({ mergeParams: true });

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

    const where = {
      firmId,
      archivedAt: null,
      ...(statusFilter ? { status: statusFilter } : {}),
    };

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          client: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phone: true,
            },
          },
        },
      }),
      prisma.lead.count({ where }),
    ]);

    // Flatten client info onto lead for frontend consumption
    const result = leads.map((l) => ({
      id: l.id,
      firmId: l.firmId,
      clientName: l.client?.fullName ?? null,
      email: l.client?.email ?? null,
      phone: l.client?.phone ?? null,
      source: l.source,
      stage: l.stage,
      status: l.status,
      assignedTo: l.assignedTo,
      convertedToCaseId: l.convertedToCaseId,
      notes: l.notes,
      createdAt: l.createdAt,
    }));

    res.status(200).json({
      ok: true,
      data: { leads: result },
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

    const lead = await prisma.lead.findFirst({
      where: { id: leadId, firmId, archivedAt: null },
      include: {
        client: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
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

    const result = {
      id: lead.id,
      firmId: lead.firmId,
      clientName: lead.client?.fullName ?? null,
      email: lead.client?.email ?? null,
      phone: lead.client?.phone ?? null,
      source: lead.source,
      stage: lead.stage,
      status: lead.status,
      assignedTo: lead.assignedTo,
      convertedToCaseId: lead.convertedToCaseId,
      notes: lead.notes,
      createdAt: lead.createdAt,
    };

    res.status(200).json({ ok: true, data: { lead: result } });
  }
);
