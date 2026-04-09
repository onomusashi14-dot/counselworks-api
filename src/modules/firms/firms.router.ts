import { Router, Request, Response } from 'express';
import { prisma } from '../../config/prisma';
import { authenticate } from '../../middleware/authenticate';
import { requireFirmAccess } from '../../middleware/requireFirmAccess';

export const firmsRouter = Router();

/**
 * GET /firms/:firmId
 * The Phase 1 gate route. Returns firm profile for members of that firm.
 */
firmsRouter.get(
  '/:firmId',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;

    const firm = await prisma.firm.findUnique({
      where: { id: firmId },
      select: { id: true, name: true, slug: true, status: true, timezone: true, createdAt: true },
    });

    // requireFirmAccess already verified this exists — this shouldn't happen
    if (!firm) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    res.status(200).json({ ok: true, data: { firm } });
  }
);

/**
 * GET /firms/:firmId/members
 */
firmsRouter.get(
  '/:firmId/members',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;

    const members = await prisma.firmMembership.findMany({
      where: { firmId, archivedAt: null },
      include: {
        user: { select: { id: true, email: true, fullName: true, lastActiveAt: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.status(200).json({
      ok: true,
      data: {
        members: members.map((m) => ({
          userId: m.userId,
          role: m.role,
          isPrimary: m.isPrimary,
          fullName: m.user.fullName,
          email: m.user.email,
          lastActiveAt: m.user.lastActiveAt,
        })),
      },
    });
  }
);
