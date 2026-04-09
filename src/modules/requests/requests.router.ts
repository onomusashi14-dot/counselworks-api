/**
 * src/modules/requests/requests.router.ts
 * Phase 3 — fixed version
 *
 * Strict rules locked:
 *   Attorneys/firm_staff  → create, view, message only (no PATCH)
 *   CW roles              → view, message, PATCH (status/assign/ETA/close)
 *   null assignedTo       → explicitly handled everywhere, never crashes
 *   Notifications         → attorney message → notify assignedTo (if set)
 *                           CW message → notify createdBy (always set)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { authenticate } from '../../middleware/authenticate';
import { requireFirmAccess } from '../../middleware/requireFirmAccess';
import { requireRole } from '../../middleware/requireRole';
import { logActivity } from '../../utils/auditLog';
import { createNotification } from '../../utils/notify';

export const requestsRouter = Router({ mergeParams: true });

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const REQUEST_TYPES = [
  'draft_request', 'status_update', 'document_chase',
  'records_summary', 'chronology', 'general',
] as const;

const REQUEST_STATUSES = [
  'open', 'in_progress', 'pending_attorney', 'completed', 'closed',
] as const;

// Maps firm role → sender_type stored in request_messages
const ROLE_TO_SENDER_TYPE: Record<string, string> = {
  managing_attorney:     'attorney',
  attorney:              'attorney',
  firm_admin:            'firm_staff',
  case_manager:          'firm_staff',
  counselworks_admin:    'counselworks_staff',
  counselworks_operator: 'counselworks_staff',
  qa_reviewer:           'counselworks_staff',
};

function senderTypeFromRole(role: string): string {
  return ROLE_TO_SENDER_TYPE[role] ?? 'counselworks_staff';
}

function isCwSender(senderType: string): boolean {
  return senderType === 'counselworks_staff';
}

// ─── SCHEMAS ──────────────────────────────────────────────────────────────────
const CreateRequestSchema = z.object({
  subject:     z.string().min(1).max(500),
  requestType: z.enum(REQUEST_TYPES).default('general'),
  caseId:      z.string().uuid().optional(),
  body:        z.string().min(1).max(20000),
}).strict();

const AddMessageSchema = z.object({
  body:            z.string().min(1).max(20000),
  isDraftDelivery: z.boolean().default(false),
}).strict();

// Only CW roles use this schema — attorney PATCH is blocked by requireRole
const UpdateRequestSchema = z.object({
  status:     z.enum(REQUEST_STATUSES).optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  eta:        z.string().datetime().nullable().optional(),
}).strict();

// ─── NOTIFICATION ROUTING ────────────────────────────────────────────────────
// Single function — all notification routing goes through here.
// Rule: attorney sends → notify CW operator (assignedTo, if not null)
//       CW sends       → notify thread creator (createdBy, always set)
// If target is null → skip silently, never throw.
async function notifyOtherParty(params: {
  senderType: string;
  senderId: string;
  thread: { id: string; subject: string; firmId: string; createdBy: string; assignedTo: string | null };
  type: string;
  title: string;
  body: string;
}): Promise<void> {
  const { senderType, senderId, thread, type, title, body } = params;

  let recipientId: string | null = null;

  if (!isCwSender(senderType)) {
    // Attorney/firm_staff sent → notify assigned CW operator
    recipientId = thread.assignedTo ?? null; // null = unassigned, skip
  } else {
    // CW sent → notify thread creator
    recipientId = thread.createdBy; // always set — never null
  }

  // Skip if no recipient (unassigned thread, attorney side has no one to notify)
  if (!recipientId || recipientId === senderId) return;

  await createNotification({
    userId:     recipientId,
    firmId:     thread.firmId,
    type,
    title,
    body,
    entityType: 'request',
    entityId:   thread.id,
  });
}

// ─── CREATE THREAD ────────────────────────────────────────────────────────────
requestsRouter.post(
  '/',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId, role } = req.firmContext!;

    const parsed = CreateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request body.', details: parsed.error.flatten() },
      });
      return;
    }

    const { subject, requestType, caseId, body: msgBody } = parsed.data;

    // Validate caseId belongs to this firm (if provided)
    if (caseId) {
      const caseRecord = await prisma.case.findFirst({
        where: { id: caseId, firmId, archivedAt: null },
        select: { id: true },
      });
      if (!caseRecord) {
        res.status(403).json({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
        });
        return;
      }
    }

    const senderType = senderTypeFromRole(role);

    const thread = await prisma.$transaction(async (tx) => {
      const newThread = await tx.request.create({
        data: {
          firmId,
          caseId:     caseId ?? null,
          createdBy:  req.user!.id,
          assignedTo: null,        // Option B: always null at creation
          subject,
          requestType,
          status: 'open',
        },
      });

      await tx.requestMessage.create({
        data: {
          requestId:      newThread.id,
          firmId,
          senderId:       req.user!.id,
          senderType,
          body:           msgBody,
          isDraftDelivery: false,
        },
      });

      return newThread;
    });

    await logActivity({
      firmId,
      actorId:      req.user!.id,
      actorType:    senderType as any,
      entityType:   'request',
      entityId:     thread.id,
      activityType: 'request_created',
      description:  `${req.user!.fullName} created request: "${subject}"`,
      ipAddress:    req.ip,
      metadata:     { requestType, caseId: caseId ?? null },
    });

    res.status(201).json({ ok: true, data: { request: thread } });
  }
);

// ─── LIST THREADS ─────────────────────────────────────────────────────────────
requestsRouter.get(
  '/',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;

    const page  = Math.max(1, parseInt(req.query.page  as string ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string ?? '25', 10)));
    const skip  = (page - 1) * limit;

    const statusFilter = req.query.status as string | undefined;
    const validStatus  = REQUEST_STATUSES.includes(statusFilter as any) ? statusFilter : undefined;

    const where = {
      firmId,
      ...(validStatus ? { status: validStatus } : {}),
    };

    const [threads, total] = await Promise.all([
      prisma.request.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id:          true,
          firmId:      true,
          caseId:      true,     // nullable — included as-is
          createdBy:   true,
          assignedTo:  true,     // nullable — included as-is, clients must handle null
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
      data: { requests: threads },
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  }
);

// ─── THREAD DETAIL + MESSAGES ─────────────────────────────────────────────────
requestsRouter.get(
  '/:requestId',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;
    const { requestId } = req.params;

    const thread = await prisma.request.findFirst({
      where: { id: requestId, firmId },   // firm_id enforced at query level too
      select: {
        id:          true,
        firmId:      true,
        caseId:      true,
        createdBy:   true,
        assignedTo:  true,   // nullable — returned as null if unassigned
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

    if (!thread) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    res.status(200).json({ ok: true, data: { request: thread } });
  }
);

// ─── ADD MESSAGE ──────────────────────────────────────────────────────────────
requestsRouter.post(
  '/:requestId/messages',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId, role } = req.firmContext!;
    const { requestId } = req.params;

    const parsed = AddMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request body.', details: parsed.error.flatten() },
      });
      return;
    }

    const thread = await prisma.request.findFirst({
      where: { id: requestId, firmId },
      select: {
        id:         true,
        status:     true,
        assignedTo: true,   // may be null — handled explicitly below
        createdBy:  true,
        subject:    true,
        firmId:     true,
      },
    });

    if (!thread) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    if (thread.status === 'closed') {
      res.status(409).json({
        ok: false,
        error: { code: 'THREAD_CLOSED', message: 'This thread is closed. Open a new request to continue.' },
      });
      return;
    }

    const { body: msgBody, isDraftDelivery } = parsed.data;
    const senderType = senderTypeFromRole(role);

    const message = await prisma.requestMessage.create({
      data: {
        requestId,
        firmId,
        senderId:       req.user!.id,
        senderType,
        body:           msgBody,
        isDraftDelivery,
      },
    });

    // Status auto-advance:
    //   Attorney/firm_staff → if open, advance to in_progress
    //   CW staff            → set to pending_attorney (awaiting attorney review)
    const nextStatus = isCwSender(senderType)
      ? 'pending_attorney'
      : thread.status === 'open' ? 'in_progress' : thread.status;

    if (nextStatus !== thread.status) {
      await prisma.request.update({
        where: { id: requestId },
        data:  { status: nextStatus },
      });
    }

    await logActivity({
      firmId,
      actorId:      req.user!.id,
      actorType:    senderType as any,
      entityType:   'request',
      entityId:     requestId,
      activityType: isDraftDelivery ? 'draft_delivered' : 'message_posted',
      description:  isDraftDelivery
        ? `${req.user!.fullName} delivered a draft on "${thread.subject}"`
        : `${req.user!.fullName} posted a message on "${thread.subject}"`,
      ipAddress: req.ip,
    });

    // Notify correct party — null assignedTo handled inside notifyOtherParty
    await notifyOtherParty({
      senderType,
      senderId: req.user!.id,
      thread,
      type:  isDraftDelivery ? 'draft_delivered' : 'new_message',
      title: isDraftDelivery
        ? `Draft delivered: ${thread.subject}`
        : `New message: ${thread.subject}`,
      body: `${req.user!.fullName} ${isDraftDelivery ? 'delivered a draft' : 'sent a message'}.`,
    });

    res.status(201).json({ ok: true, data: { message } });
  }
);

// ─── UPDATE THREAD — CW ROLES ONLY ───────────────────────────────────────────
// requireRole enforces: only counselworks_admin and counselworks_operator
// Attorneys hitting this endpoint get 403 INSUFFICIENT_ROLE from middleware
requestsRouter.patch(
  '/:requestId',
  authenticate,
  requireFirmAccess(),
  requireRole('counselworks_admin', 'counselworks_operator'),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;
    const { requestId } = req.params;

    const parsed = UpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request body.', details: parsed.error.flatten() },
      });
      return;
    }

    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({
        ok: false,
        error: { code: 'NO_CHANGES', message: 'No fields to update.' },
      });
      return;
    }

    const thread = await prisma.request.findFirst({
      where: { id: requestId, firmId },
      select: { id: true, status: true, assignedTo: true, eta: true, subject: true, createdBy: true },
    });

    if (!thread) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    const { status, assignedTo, eta } = parsed.data;
    const isClosing = status === 'closed' && thread.status !== 'closed';

    const updated = await prisma.request.update({
      where: { id: requestId },
      data: {
        ...(status     !== undefined ? { status }                                        : {}),
        ...(assignedTo !== undefined ? { assignedTo: assignedTo ?? null }               : {}),
        ...(eta        !== undefined ? { eta: eta ? new Date(eta) : null }               : {}),
        ...(isClosing               ? { closedAt: new Date() }                          : {}),
      },
    });

    // Build plain-language description of changes
    const changes: string[] = [];
    if (status     !== undefined && status     !== thread.status)     changes.push(`status → ${status}`);
    if (assignedTo !== undefined && assignedTo !== thread.assignedTo) changes.push(`assigned_to → ${assignedTo ?? 'unassigned'}`);
    if (eta        !== undefined)                                      changes.push(`eta → ${eta ?? 'cleared'}`);

    if (changes.length > 0) {
      await logActivity({
        firmId,
        actorId:      req.user!.id,
        actorType:    'counselworks_staff',
        entityType:   'request',
        entityId:     requestId,
        activityType: isClosing ? 'request_closed' : 'request_updated',
        description:  isClosing
          ? `${req.user!.fullName} closed request "${thread.subject}"`
          : `${req.user!.fullName} updated request "${thread.subject}": ${changes.join(', ')}`,
        ipAddress: req.ip,
        metadata:  { changes },
      });
    }

    // Notify attorney of status change
    if (status !== undefined && status !== thread.status) {
      await createNotification({
        userId:     thread.createdBy,   // always set
        firmId,
        type:       'request_status_changed',
        title:      `Request updated: ${thread.subject}`,
        body:       `Status changed to ${status}.`,
        entityType: 'request',
        entityId:   requestId,
      });
    }

    // Notify newly assigned operator (only if assignedTo changed to a non-null value)
    if (assignedTo !== undefined && assignedTo !== null && assignedTo !== thread.assignedTo) {
      await createNotification({
        userId:     assignedTo,
        firmId,
        type:       'request_assigned',
        title:      `Request assigned to you: ${thread.subject}`,
        body:       `${req.user!.fullName} assigned this request to you.`,
        entityType: 'request',
        entityId:   requestId,
      });
    }

    res.status(200).json({ ok: true, data: { request: updated } });
  }
);
