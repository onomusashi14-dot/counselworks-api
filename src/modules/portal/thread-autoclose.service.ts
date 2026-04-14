/**
 * src/modules/portal/thread-autoclose.service.ts
 *
 * If a thread is sitting in 'pending_attorney' for more than 48 hours and the
 * attorney has not replied, auto-close it to 'completed'. This prevents the
 * Requests inbox from growing stale and matches the product rule that
 * CounselWorks does not wait indefinitely on attorney silence.
 *
 * Rules:
 *   - Only closes threads whose status is 'pending_attorney' and closedAt is null.
 *   - Only closes when lastMessageAt (the CW staff reply that put the thread
 *     into pending_attorney) is more than 48h old.
 *   - Also sanity-checks the last message was NOT from the attorney/firm_staff,
 *     so a race condition where status wasn't updated after an attorney reply
 *     does not silently close a live conversation.
 *   - Writes an ActivityLog row with activity_type='thread_auto_closed' so the
 *     timeline shows why the thread was closed.
 *   - Appends a system message to the thread so the attorney sees context when
 *     they reopen it.
 *
 * Idempotent — a second run immediately after the first will find no candidates.
 */

import type { PrismaClient } from '@prisma/client';
import { logActivity } from '../../utils/auditLog';

const AUTO_CLOSE_AFTER_MS = 48 * 60 * 60 * 1000;

export interface AutoCloseRunResult {
  checked: number;
  closed: number;
  skippedLiveReply: number;
}

export async function runThreadAutoClose(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<AutoCloseRunResult> {
  const result: AutoCloseRunResult = { checked: 0, closed: 0, skippedLiveReply: 0 };
  const cutoff = new Date(now.getTime() - AUTO_CLOSE_AFTER_MS);

  const candidates = await prisma.request.findMany({
    where: {
      status: 'pending_attorney',
      closedAt: null,
      lastMessageAt: { lt: cutoff },
    },
    select: { id: true, firmId: true, caseId: true, subject: true },
  });
  result.checked = candidates.length;

  for (const thread of candidates) {
    // Safety check: look at the most recent message. Only close if it was
    // from a non-attorney source (CW staff, system, or AI). If the most recent
    // message came from the attorney/firm, the thread is still live.
    const lastMessage = await prisma.requestMessage.findFirst({
      where: { requestId: thread.id },
      orderBy: { createdAt: 'desc' },
      select: { senderType: true, createdAt: true },
    });

    if (
      lastMessage &&
      (lastMessage.senderType === 'attorney' || lastMessage.senderType === 'firm_staff')
    ) {
      result.skippedLiveReply += 1;
      continue;
    }

    await prisma.request.update({
      where: { id: thread.id },
      data: { status: 'completed', closedAt: now },
    });

    await prisma.requestMessage.create({
      data: {
        requestId: thread.id,
        firmId: thread.firmId,
        senderId: null,
        senderType: 'system',
        messageKind: 'system_note',
        body:
          'Thread auto-closed: no attorney reply in 48 hours. Reopen or create a new thread to continue.',
      },
    });

    await logActivity({
      firmId: thread.firmId,
      actorType: 'system',
      entityType: 'request',
      entityId: thread.id,
      activityType: 'thread_auto_closed',
      description: `Thread "${thread.subject}" auto-closed (no attorney reply in 48h)`,
      metadata: {
        case_id: thread.caseId,
        reason: 'no_attorney_reply_48h',
      },
    });

    result.closed += 1;
  }

  return result;
}
