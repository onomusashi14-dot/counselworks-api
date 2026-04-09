/**
 * src/modules/notifications/notifications.router.ts
 *
 * User-scoped notification endpoints.
 * Users only ever see their own notifications — enforced at query level.
 *
 * Routes:
 *   GET   /notifications           Current user's notifications (paginated)
 *   PATCH /notifications/:id/read  Mark one notification read
 *   PATCH /notifications/read-all  Mark all read
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../../config/prisma';
import { authenticate } from '../../middleware/authenticate';

export const notificationsRouter = Router();

// ─── LIST NOTIFICATIONS ───────────────────────────────────────────────────────
notificationsRouter.get(
  '/',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.id;
    const page   = Math.max(1, parseInt(req.query.page  as string ?? '1',  10));
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit as string ?? '25', 10)));
    const skip   = (page - 1) * limit;
    const unreadOnly = req.query.unread === 'true';

    const where = {
      userId,
      ...(unreadOnly ? { readAt: null } : {}),
    };

    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          type: true,
          title: true,
          body: true,
          entityType: true,
          entityId: true,
          readAt: true,
          createdAt: true,
          // firmId intentionally included — helps client route to correct firm context
          firmId: true,
        },
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId, readAt: null } }),
    ]);

    res.status(200).json({
      ok: true,
      data: { notifications },
      meta: { page, limit, total, pages: Math.ceil(total / limit), unreadCount },
    });
  }
);

// ─── MARK ONE READ ────────────────────────────────────────────────────────────
// Route order matters: /read-all must be registered before /:id/read
// to prevent "read-all" being interpreted as an :id param.
notificationsRouter.patch(
  '/read-all',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.id;

    const result = await prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });

    res.status(200).json({
      ok: true,
      data: { updated: result.count },
    });
  }
);

notificationsRouter.patch(
  '/:notificationId/read',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const userId         = req.user!.id;
    const notificationId = req.params.notificationId;

    // findFirst with userId ensures users can only mark their own notifications read
    const notification = await prisma.notification.findFirst({
      where: { id: notificationId, userId },
      select: { id: true, readAt: true },
    });

    if (!notification) {
      // 403 — don't reveal whether the notification exists for another user
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    if (notification.readAt) {
      // Already read — idempotent, return 200
      res.status(200).json({ ok: true, data: { alreadyRead: true } });
      return;
    }

    const updated = await prisma.notification.update({
      where: { id: notificationId },
      data: { readAt: new Date() },
      select: { id: true, readAt: true, type: true, title: true },
    });

    res.status(200).json({ ok: true, data: { notification: updated } });
  }
);
