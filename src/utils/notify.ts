/**
 * src/utils/notify.ts
 *
 * Creates a notification record for a user.
 * Failures are swallowed — a failed notification must never crash a request.
 *
 * Usage:
 *   await createNotification({
 *     userId: assignedUser.id,
 *     firmId: request.firmId,
 *     type: 'new_message',
 *     title: 'New message on Martinez demand draft',
 *     body: 'R. Okonkwo replied to your thread.',
 *     entityType: 'request',
 *     entityId: request.id,
 *   });
 */

import { prisma } from '../config/prisma';

export interface CreateNotificationParams {
  userId: string;
  firmId?: string;
  type: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
}

export async function createNotification(params: CreateNotificationParams): Promise<void> {
  const { userId, firmId, type, title, body, entityType, entityId } = params;
  try {
    await prisma.notification.create({
      data: {
        userId,
        firmId: firmId ?? null,
        type,
        title,
        body,
        entityType: entityType ?? null,
        entityId: entityId ?? null,
      },
    });
  } catch (err) {
    // Notification failure must never crash the main request
    console.error('[NOTIFICATION FAILURE]', err);
  }
}
