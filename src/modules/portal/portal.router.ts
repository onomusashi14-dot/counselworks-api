/**
 * src/modules/portal/portal.router.ts
 *
 * Attorney-facing portal API. Responses are FLAT (no { ok, data } wrapper) —
 * the frontend consumes them directly via portalApi.ts.
 *
 * Tenant isolation:
 *   All reads/writes are scoped to req.firmContext.firmId via requireFirmAccess.
 *   Attorneys see only cases where primary_attorney_id = req.user.id unless
 *   they have a non-attorney role (firm_admin, case_manager, or CW staff).
 *
 * Endpoints:
 *   GET  /firms/:firmId/portal/morning-brief
 *   GET  /firms/:firmId/portal/cases
 *   GET  /firms/:firmId/portal/cases/:caseId
 *   GET  /firms/:firmId/portal/threads
 *   GET  /firms/:firmId/portal/threads/:threadId
 *   POST /firms/:firmId/portal/threads
 *   POST /firms/:firmId/portal/threads/:threadId/messages
 *   GET  /firms/:firmId/portal/drafts
 *   GET  /firms/:firmId/portal/documents
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { authenticate } from '../../middleware/authenticate';
import { requireFirmAccess } from '../../middleware/requireFirmAccess';
import { logActivity } from '../../utils/auditLog';
import { createNotification } from '../../utils/notify';
import {
  recomputeCaseHealth,
  shapeCaseForPortal,
  shapeThreadForPortal,
  shapeDraftForPortal,
  shapeDocumentForPortal,
  readinessFromChecklist,
  formatRelativeTime,
  buildCaseName,
} from './portal.helpers';
import { recomputeAndPersist, deriveMrrEscalationLevel } from './case-health.service';
import { callClaude } from '../ai/ai-client';
import { INTERPRET_SYSTEM } from '../ai/ai.router';
import { logAICall } from '../ai/ai-log.service';

export const portalRouter = Router({ mergeParams: true });

// ─── HELPER: background thread interpretation via Claude ─────────────────────
// Runs AFTER the HTTP response is sent. Never throws — every path is wrapped
// in try/catch so a Claude failure can never propagate back to the attorney.
//
// Confidence rules (Prompt 5 §7):
//   ≥ 0.8  → auto-assign to lead_case_coordinator, set status=in_progress,
//            post a system acknowledgment, persist requestType + eta.
//   0.5-0.79 → leave in supervisor triage (log only).
//   < 0.5  → leave in supervisor triage + flag needs_clarification.
//   failure → leave in supervisor triage.
//
// Interpretation metadata lives in the ai_call ActivityLog row — the Request
// model has no interpreted_intent / interpretation_confidence columns.
async function interpretThreadInBackground(params: {
  firmId: string;
  threadId: string;
  caseId: string | null;
  subject: string;
  messageBody: string;
  triggeringUserId: string;
}): Promise<void> {
  const { firmId, threadId, caseId, subject, messageBody, triggeringUserId } = params;

  console.log(`[AI interpret] START thread=${threadId} firm=${firmId} case=${caseId ?? 'null'} subject="${subject.slice(0, 80)}"`);

  try {
    // Gather minimal case metadata to improve classification accuracy.
    let caseMetadata = '';
    if (caseId) {
      const c = await prisma.case.findUnique({
        where: { id: caseId },
        select: { caseType: true, jurisdiction: true, phase: true, status: true },
      });
      if (c) {
        caseMetadata = `Case type: ${c.caseType ?? 'unknown'} | Jurisdiction: ${c.jurisdiction ?? 'unknown'} | Phase: ${c.phase ?? 'unknown'} | Status: ${c.status ?? 'unknown'}`;
      }
    }

    const userMessage = [
      `Attorney subject: ${subject}`,
      `Attorney message: ${messageBody}`,
      caseMetadata ? `Case context: ${caseMetadata}` : null,
    ]
      .filter(Boolean)
      .join('\n\n');

    console.log(`[AI interpret] calling callClaude() for thread=${threadId}`);
    const result = await callClaude(INTERPRET_SYSTEM, userMessage, { maxTokens: 512 });
    console.log(`[AI interpret] callClaude returned | thread=${threadId} | success=${result.success} | durationMs=${result.durationMs} | output=${JSON.stringify(result.output).slice(0, 300)}`);

    // Always log the call, success or failure.
    await logAICall({
      firmId,
      caseId: caseId ?? undefined,
      endpoint: 'threads/interpret',
      triggeringUserId,
      inputSummary: `thread=${threadId} subject="${subject.slice(0, 100)}"`,
      result,
    }).catch((err) => console.error('[portal] logAICall failed', err));

    if (!result.success) {
      console.warn(`[AI interpret] FAILURE — leaving thread=${threadId} for supervisor triage. Reason: ${JSON.stringify(result.output)}`);
      return;
    }

    const out = result.output ?? {};
    const confidence = typeof out.confidence === 'number' ? out.confidence : 0;
    const requestType = typeof out.request_type === 'string' ? out.request_type : null;
    const intent = typeof out.intent === 'string' ? out.intent : null;
    const suggestedEtaDays =
      typeof out.suggested_eta_days === 'number' && Number.isFinite(out.suggested_eta_days)
        ? Math.max(0, Math.floor(out.suggested_eta_days))
        : null;

    // Map AI request_type vocabulary to the portal enum used on Request.requestType.
    const requestTypeMap: Record<string, string> = {
      records_request: 'document_chase',
      draft_request: 'draft_request',
      follow_up: 'status_update',
      research: 'general',
      scheduling: 'general',
      client_communication: 'general',
      general_instruction: 'general',
    };
    const mappedRequestType = requestType && requestTypeMap[requestType] ? requestTypeMap[requestType] : null;

    console.log(`[AI interpret] parsed | thread=${threadId} | confidence=${confidence} | requestType=${requestType} | mappedTo=${mappedRequestType} | intent="${(intent ?? '').slice(0, 100)}"`);

    if (confidence < 0.8) {
      console.log(`[AI interpret] confidence ${confidence} < 0.8 — leaving thread=${threadId} for supervisor triage`);
      return;
    }

    // High confidence path: auto-assign to lead paralegal.
    console.log(`[AI interpret] HIGH CONFIDENCE (${confidence}) — looking up lead_case_coordinator for firm=${firmId}`);

    const assignment = await prisma.firmAssignment.findFirst({
      where: {
        firmId,
        unassignedAt: null,
        role: 'lead_case_coordinator',
      },
      select: { cwUserId: true },
    });

    // Diagnostic: dump all active assignments for this firm if the target role is missing.
    if (!assignment) {
      const allAssignments = await prisma.firmAssignment.findMany({
        where: { firmId, unassignedAt: null },
        select: { cwUserId: true, role: true, isPrimary: true },
      });
      console.warn(
        `[AI interpret] NO lead_case_coordinator for firm=${firmId}. ` +
          `Active assignments: ${JSON.stringify(allAssignments)}. ` +
          `Thread ${threadId} left for triage. ` +
          `Fix: run 'npm run db:seed' or insert a firm_assignment row with role='lead_case_coordinator'.`,
      );
      return;
    }

    console.log(`[AI interpret] found lead_case_coordinator cwUserId=${assignment.cwUserId} for firm=${firmId}`);

    const paralegal = await prisma.user.findUnique({
      where: { id: assignment.cwUserId },
      select: { id: true, fullName: true },
    });

    if (!paralegal) {
      console.warn(`[AI interpret] lead_case_coordinator user ${assignment.cwUserId} not found — thread ${threadId} left for triage`);
      return;
    }

    console.log(`[AI interpret] paralegal resolved: ${paralegal.fullName} (${paralegal.id})`);

    const etaDate =
      suggestedEtaDays !== null
        ? new Date(Date.now() + suggestedEtaDays * 24 * 60 * 60 * 1000)
        : null;

    await prisma.request.update({
      where: { id: threadId },
      data: {
        status: 'in_progress',
        assignedTo: paralegal.id,
        ...(mappedRequestType ? { requestType: mappedRequestType } : {}),
        ...(etaDate ? { eta: etaDate } : {}),
      },
    });

    const ackBody = [
      `Assigned to ${paralegal.fullName}.`,
      intent ? `Understood as: ${intent}` : null,
      etaDate ? `Target completion: ${etaDate.toISOString().slice(0, 10)}` : null,
      '',
      'This acknowledgment was generated from an AI classification and will be reviewed by a human before any attorney follow-up. Not legal advice.',
    ]
      .filter(Boolean)
      .join('\n');

    await prisma.requestMessage.create({
      data: {
        requestId: threadId,
        firmId,
        senderId: null,
        senderType: 'system',
        messageKind: 'system_note',
        body: ackBody,
      },
    });

    await prisma.request.update({
      where: { id: threadId },
      data: { lastMessageAt: new Date() },
    });

    await logActivity({
      firmId,
      actorId: paralegal.id,
      actorType: 'ai',
      entityType: 'request',
      entityId: threadId,
      activityType: 'thread_auto_assigned',
      description: `AI auto-assigned thread to ${paralegal.fullName} (confidence ${confidence.toFixed(2)})`,
      metadata: {
        confidence,
        request_type: requestType,
        intent,
        suggested_eta_days: suggestedEtaDays,
      },
    }).catch((err) => console.error('[AI interpret] logActivity(thread_auto_assigned) failed', err));

    console.log(`[AI interpret] DONE thread=${threadId} assigned to ${paralegal.fullName} status=in_progress`);
  } catch (err) {
    // Swallow everything — this function must never throw back to the caller.
    console.error(`[AI interpret] UNCAUGHT error for thread=${threadId}:`, err);
  }
}

// ─── HELPER: attorney case filter ─────────────────────────────────────────────
function caseScopeFilter(req: Request) {
  const { role } = req.firmContext!;
  if (role === 'attorney' || role === 'managing_attorney') {
    return { primaryAttorneyId: req.user!.id };
  }
  return {};
}

// ─── HELPER: load user name cache for a batch of user ids ────────────────────
async function loadUserNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((x): x is string => !!x)));
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, fullName: true },
  });
  return new Map(users.map((u) => [u.id, u.fullName]));
}

// ─── HELPER: look up CW pod assignments for a firm ───────────────────────────
async function loadPodAssignments(firmId: string) {
  const rows = await prisma.firmAssignment.findMany({
    where: { firmId, unassignedAt: null },
    select: { cwUserId: true, role: true, isPrimary: true },
  });
  const userIds = rows.map((r) => r.cwUserId);
  const names = await loadUserNames(userIds);

  const paralegal = rows.find((r) => r.role === 'lead_case_coordinator' || r.role === 'paralegal');
  const records = rows.find((r) => r.role === 'records_specialist');
  return {
    paralegalName: paralegal ? names.get(paralegal.cwUserId) ?? '—' : '—',
    recordsName: records ? names.get(records.cwUserId) ?? '—' : '—',
  };
}

function humanizeRole(role: string): string {
  const map: Record<string, string> = {
    lead_case_coordinator: 'Lead Case Coordinator',
    paralegal: 'Paralegal',
    records_specialist: 'Records Specialist',
    qa_supervisor: 'QA Supervisor',
    intake_specialist: 'Intake Specialist',
    attorney: 'Attorney',
  };
  return map[role] ?? role.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function greetingForHour(d: Date): string {
  const h = d.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function todayLabel(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatLastActive(ms: number | null): { lastActive: string; isActive: boolean } {
  if (ms === null) return { lastActive: 'Offline', isActive: false };
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  const isActive = minutes <= 30;
  if (minutes < 60) return { lastActive: `${minutes} minute${minutes === 1 ? '' : 's'} ago`, isActive };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { lastActive: `${hours} hour${hours === 1 ? '' : 's'} ago`, isActive };
  const days = Math.floor(hours / 24);
  return { lastActive: days === 1 ? 'yesterday' : `${days} days ago`, isActive };
}

// ═════════════════════════════════════════════════════════════════════════════
// GET /portal/morning-brief
// ═════════════════════════════════════════════════════════════════════════════
portalRouter.get(
  '/morning-brief',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;
    const scope = caseScopeFilter(req);
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [cases, pod] = await Promise.all([
      prisma.case.findMany({
        where: { firmId, archivedAt: null, ...scope },
        orderBy: [{ healthStatus: 'desc' }, { lastActivityAt: 'desc' }],
        take: 200,
      }),
      loadPodAssignments(firmId),
    ]);

    const attorneyIds = cases.map((c) => c.primaryAttorneyId).filter((x): x is string => !!x);
    const attorneyNames = await loadUserNames(attorneyIds);

    // Team members derived from active firm_assignments
    const teamRows = await prisma.firmAssignment.findMany({
      where: { firmId, unassignedAt: null },
      select: { cwUserId: true, role: true },
    });
    const teamNames = await loadUserNames(teamRows.map((r) => r.cwUserId));
    const team = await Promise.all(
      teamRows.map(async (r) => {
        const cwUser = await prisma.user.findUnique({
          where: { id: r.cwUserId },
          select: { fullName: true, lastActiveAt: true },
        });
        const openTasks = await prisma.task.count({
          where: { firmId, assignedTo: r.cwUserId, status: { in: ['open', 'in_progress'] } },
        });
        const msSinceActive = cwUser?.lastActiveAt ? Date.now() - cwUser.lastActiveAt.getTime() : null;
        const { lastActive, isActive } = formatLastActive(msSinceActive);
        return {
          name: teamNames.get(r.cwUserId) ?? 'Unknown',
          role: humanizeRole(r.role),
          activitySummary: `Handling ${openTasks} active task${openTasks === 1 ? '' : 's'}`,
          lastActive,
          isActive,
        };
      }),
    );

    // ── Attention items — derived from real case state ──────────────────────
    // Red:
    //   - Any case whose stored healthStatus='blocked'
    //   - Any medical record request at escalation level ≥ 2 (≥21 days)
    //   - Any task in [open,in_progress] past its dueAt
    // Amber:
    //   - Any case whose stored healthStatus='needs_attention'
    //   - Any Request in status='pending_attorney' with closedAt null
    const caseById = new Map(cases.map((c) => [c.id, c]));
    const inScopeCaseIds = Array.from(caseById.keys());

    // Seed with base case-level items.
    const attentionItems: Array<{
      id: string;
      severity: 'red' | 'amber';
      caseId: string;
      caseName: string;
      matterNumber: string;
      description: string;
      handler?: string;
      nextUpdate?: string;
    }> = [];

    for (const c of cases) {
      if (c.healthStatus === 'blocked') {
        attentionItems.push({
          id: `case-${c.id}`,
          severity: 'red',
          caseId: c.id,
          caseName: buildCaseName(c),
          matterNumber: c.matterNumber,
          description: c.healthSummary ?? 'Case is blocked — see case detail for reasons.',
          handler: pod.paralegalName,
          nextUpdate: 'within 2 hours',
        });
      } else if (c.healthStatus === 'needs_attention') {
        attentionItems.push({
          id: `case-${c.id}`,
          severity: 'amber',
          caseId: c.id,
          caseName: buildCaseName(c),
          matterNumber: c.matterNumber,
          description: c.healthSummary ?? c.nextAction ?? 'Needs attorney review.',
          handler: pod.paralegalName,
          nextUpdate: 'end of day',
        });
      }
    }

    // Pull in MRR-level red items (not already covered by case-level blocked).
    if (inScopeCaseIds.length > 0) {
      const openMrrs = await prisma.medicalRecordRequest.findMany({
        where: {
          caseId: { in: inScopeCaseIds },
          archivedAt: null,
          recordsReceivedAt: null,
        },
        select: { id: true, caseId: true, providerName: true, createdAt: true, status: true },
      });
      for (const mrr of openMrrs) {
        const level = deriveMrrEscalationLevel(mrr.createdAt, now);
        if (level < 2 && mrr.status !== 'escalated') continue;
        const c = caseById.get(mrr.caseId);
        if (!c) continue;
        const ageDays = Math.floor(
          (now.getTime() - mrr.createdAt.getTime()) / (24 * 60 * 60 * 1000),
        );
        attentionItems.push({
          id: `mrr-${mrr.id}`,
          severity: 'red',
          caseId: c.id,
          caseName: buildCaseName(c),
          matterNumber: c.matterNumber,
          description: `${mrr.providerName} records ${ageDays} days overdue`,
          handler: pod.recordsName,
          nextUpdate: 'today',
        });
      }

      // Task SLA breaches
      const breachedTasks = await prisma.task.findMany({
        where: {
          caseId: { in: inScopeCaseIds },
          archivedAt: null,
          status: { in: ['open', 'in_progress'] },
          dueAt: { lt: now, not: null },
        },
        select: { id: true, caseId: true, title: true, dueAt: true, assignedTo: true },
      });
      const breachedHandlerIds = breachedTasks
        .map((t) => t.assignedTo)
        .filter((x): x is string => !!x);
      const breachedHandlerNames = await loadUserNames(breachedHandlerIds);
      for (const t of breachedTasks) {
        if (!t.caseId) continue;
        const c = caseById.get(t.caseId);
        if (!c) continue;
        const hoursOver = t.dueAt
          ? Math.max(1, Math.floor((now.getTime() - t.dueAt.getTime()) / (60 * 60 * 1000)))
          : 0;
        attentionItems.push({
          id: `task-${t.id}`,
          severity: 'red',
          caseId: c.id,
          caseName: buildCaseName(c),
          matterNumber: c.matterNumber,
          description: `Task "${t.title}" is ${hoursOver}h past SLA`,
          handler: t.assignedTo
            ? breachedHandlerNames.get(t.assignedTo) ?? pod.paralegalName
            : pod.paralegalName,
          nextUpdate: 'today',
        });
      }

      // Threads waiting on attorney
      const pendingThreads = await prisma.request.findMany({
        where: {
          caseId: { in: inScopeCaseIds },
          status: 'pending_attorney',
          closedAt: null,
        },
        select: { id: true, caseId: true, subject: true, assignedTo: true },
      });
      const pendingHandlerIds = pendingThreads
        .map((t) => t.assignedTo)
        .filter((x): x is string => !!x);
      const pendingHandlerNames = await loadUserNames(pendingHandlerIds);
      for (const t of pendingThreads) {
        if (!t.caseId) continue;
        const c = caseById.get(t.caseId);
        if (!c) continue;
        attentionItems.push({
          id: `thread-${t.id}`,
          severity: 'amber',
          caseId: c.id,
          caseName: buildCaseName(c),
          matterNumber: c.matterNumber,
          description: `Awaiting your review: "${t.subject}"`,
          handler: t.assignedTo
            ? pendingHandlerNames.get(t.assignedTo) ?? pod.paralegalName
            : pod.paralegalName,
          nextUpdate: 'at your convenience',
        });
      }
    }

    // Sort: red before amber; preserve insertion order within each tier.
    attentionItems.sort((a, b) => {
      if (a.severity === b.severity) return 0;
      return a.severity === 'red' ? -1 : 1;
    });

    // Weekly activity summary — real counts from DB
    const [leadsProcessed, casesAdvanced, documentsCollected, draftsDelivered] = await Promise.all([
      prisma.case.count({
        where: { firmId, createdAt: { gte: sevenDaysAgo } },
      }),
      prisma.case.count({
        where: { firmId, archivedAt: null, lastActivityAt: { gte: sevenDaysAgo } },
      }),
      prisma.file.count({
        where: { firmId, archivedAt: null, createdAt: { gte: sevenDaysAgo } },
      }),
      prisma.draft.count({
        where: { firmId, archivedAt: null, deliveredAt: { gte: sevenDaysAgo } },
      }),
    ]);

    // Portfolio table: all in-scope cases (shaped)
    const portfolio = cases.map((c) =>
      shapeCaseForPortal(c, {
        assignedParalegalName: pod.paralegalName,
        assignedRecordsSpecialistName: pod.recordsName,
        assignedAttorneyName: attorneyNames.get(c.primaryAttorneyId ?? '') ?? '—',
      }),
    );

    res.status(200).json({
      greeting: greetingForHour(now),
      date: todayLabel(now),
      attentionItems,
      team,
      weekSummary: {
        leadsProcessed,
        casesAdvanced,
        documentsCollected,
        draftsDelivered,
      },
      portfolio,
    });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// GET /portal/cases
// ═════════════════════════════════════════════════════════════════════════════
portalRouter.get(
  '/cases',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;
    const scope = caseScopeFilter(req);

    const [cases, pod] = await Promise.all([
      prisma.case.findMany({
        where: { firmId, archivedAt: null, ...scope },
        orderBy: [{ priority: 'desc' }, { lastActivityAt: 'desc' }],
        take: 200,
      }),
      loadPodAssignments(firmId),
    ]);

    const attorneyIds = cases.map((c) => c.primaryAttorneyId).filter((x): x is string => !!x);
    const attorneyNames = await loadUserNames(attorneyIds);

    const basisByCaseId = new Map<string, string>();
    await Promise.all(
      cases.map(async (c) => {
        const { completed, total } = await readinessFromChecklist(prisma, c.id);
        basisByCaseId.set(
          c.id,
          total > 0
            ? `Based on ${completed} of ${total} required items completed.`
            : 'Intake phase — checklist not yet built.',
        );
      }),
    );

    const shaped = cases.map((c) =>
      shapeCaseForPortal(c, {
        assignedParalegalName: pod.paralegalName,
        assignedRecordsSpecialistName: pod.recordsName,
        assignedAttorneyName: attorneyNames.get(c.primaryAttorneyId ?? '') ?? '—',
        readinessBasis: basisByCaseId.get(c.id),
      }),
    );

    res.status(200).json({ cases: shaped });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// GET /portal/cases/:caseId
// ═════════════════════════════════════════════════════════════════════════════
portalRouter.get(
  '/cases/:caseId',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId, role } = req.firmContext!;
    const { caseId } = req.params;

    const c = await prisma.case.findFirst({
      where: { id: caseId, firmId, archivedAt: null },
    });
    if (!c) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
      return;
    }
    if ((role === 'attorney' || role === 'managing_attorney') && c.primaryAttorneyId !== req.user!.id) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
      return;
    }

    const [pod, checklist, files, timeline, attorneyName, caseDrafts, caseThreads, openMrrs] = await Promise.all([
      loadPodAssignments(firmId),
      prisma.checklistItem.findMany({
        where: { caseId, archivedAt: null },
        orderBy: [{ checklistType: 'asc' }, { sortOrder: 'asc' }],
      }),
      prisma.file.findMany({
        where: { caseId, archivedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.activityLog.findMany({
        where: { entityType: 'case', entityId: caseId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      c.primaryAttorneyId
        ? prisma.user.findUnique({ where: { id: c.primaryAttorneyId }, select: { fullName: true } })
        : Promise.resolve(null),
      prisma.draft.findMany({
        where: { caseId, archivedAt: null },
        orderBy: [{ deliveredAt: 'desc' }, { createdAt: 'desc' }],
        include: {
          qaReviews: {
            where: { status: 'approved' },
            orderBy: { completedAt: 'desc' },
            take: 1,
            select: { reviewerId: true, completedAt: true },
          },
        },
      }),
      prisma.request.findMany({
        where: { firmId, caseId },
        orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
        include: {
          case: { select: { id: true, clientName: true, caseName: true, matterNumber: true, caseType: true, healthStatus: true } },
        },
        take: 50,
      }),
      // Fix 3: open medical record requests drive the dynamic escalation timeline.
      // The MedicalRecordRequest model has no `requestedDate` column — step rungs
      // are calculated from createdAt. "Open" = recordsReceivedAt IS NULL (mirrors
      // escalation.service.ts and case-health.service.ts conventions).
      prisma.medicalRecordRequest.findMany({
        where: { caseId, archivedAt: null, recordsReceivedAt: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          providerName: true,
          createdAt: true,
          hitechLetterSentAt: true,
          recordsReceivedAt: true,
          status: true,
        },
      }),
    ]);

    // ─── Fix 3: build dynamic escalation timelines ────────────────────────────
    // Each open MRR produces a 4-rung timeline anchored at createdAt:
    //   Day 3  → Phone follow-up
    //   Day 7  → Second letter
    //   Day 14 → Compliance escalation
    //   Day 30 → Attorney alert
    // State:
    //   done    — now >= step date
    //   current — first non-done step (the next action)
    //   pending — everything after current
    // We always label the request "Medical Records" because MedicalRecordRequest
    // has no recordType column (no way to distinguish billing vs medical here).
    const ESCALATION_RUNGS: { offsetDays: number; label: string }[] = [
      { offsetDays: 3, label: 'Phone follow-up' },
      { offsetDays: 7, label: 'Second letter' },
      { offsetDays: 14, label: 'Compliance escalation' },
      { offsetDays: 30, label: 'Attorney alert' },
    ];
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const escalations = openMrrs.map((mrr) => {
      const base = mrr.createdAt.getTime();
      const rawSteps = ESCALATION_RUNGS.map((rung) => {
        const target = new Date(base + rung.offsetDays * DAY_MS);
        return {
          label: rung.label,
          dueAt: target.toISOString(),
          offsetDays: rung.offsetDays,
          isDone: now >= target.getTime(),
        };
      });
      const firstPendingIdx = rawSteps.findIndex((s) => !s.isDone);
      const steps = rawSteps.map((s, idx) => ({
        label: s.label,
        dueAt: s.dueAt,
        offsetDays: s.offsetDays,
        state:
          s.isDone
            ? ('done' as const)
            : idx === firstPendingIdx
              ? ('current' as const)
              : ('pending' as const),
      }));
      return {
        id: mrr.id,
        provider: mrr.providerName,
        recordType: 'Medical Records',
        requestedAt: mrr.createdAt.toISOString(),
        status: mrr.status,
        steps,
      };
    });

    const { completed, total } = await readinessFromChecklist(prisma, caseId);
    const readinessBasis =
      total > 0
        ? `Based on ${completed} of ${total} required items completed.`
        : 'Intake phase — checklist not yet built.';

    const shapedCase = shapeCaseForPortal(c, {
      assignedParalegalName: pod.paralegalName,
      assignedRecordsSpecialistName: pod.recordsName,
      assignedAttorneyName: attorneyName?.fullName ?? '—',
      readinessBasis,
    });

    const uploaderIds = files.map((f) => f.uploadedBy).filter((x): x is string => !!x);
    const uploaderNames = await loadUserNames(uploaderIds);

    const preparerIds = caseDrafts.map((d) => d.reviewedBy).filter((x): x is string => !!x);
    const reviewerIds = caseDrafts
      .flatMap((d) => d.qaReviews.map((q) => q.reviewerId))
      .filter((x): x is string => !!x);
    const draftNames = await loadUserNames([...preparerIds, ...reviewerIds]);

    const threadHandlerIds = caseThreads.map((t) => t.assignedTo).filter((x): x is string => !!x);
    const threadHandlerNames = await loadUserNames(threadHandlerIds);

    await logActivity({
      firmId,
      actorId: req.user!.id,
      actorType: role.startsWith('counselworks') ? 'counselworks_staff' : 'attorney',
      entityType: 'case',
      entityId: caseId,
      activityType: 'case_viewed',
      description: `${req.user!.fullName} viewed case ${c.matterNumber}`,
      ipAddress: req.ip,
    });

    const caseNameStr = buildCaseName(c);

    res.status(200).json({
      case: shapedCase,
      checklist: checklist.map((ci) => ({
        id: ci.id,
        label: ci.label,
        status: ci.status,
        required: ci.required,
        dueAt: ci.dueAt,
        checklistType: ci.checklistType,
      })),
      documents: files.map((f) =>
        shapeDocumentForPortal(f, {
          caseName: caseNameStr,
          uploadedByName: uploaderNames.get(f.uploadedBy ?? '') ?? '—',
        }),
      ),
      drafts: caseDrafts.map((d) =>
        shapeDraftForPortal(d, {
          caseName: caseNameStr,
          preparedByName: draftNames.get(d.reviewedBy ?? '') ?? '—',
          reviewedByName: draftNames.get(d.qaReviews[0]?.reviewerId ?? '') ?? '—',
          qaScore: d.confidenceScore ?? 0,
        }),
      ),
      threads: caseThreads.map((t) =>
        shapeThreadForPortal(t, {
          caseName: t.case ? buildCaseName(t.case) : caseNameStr,
          handlerName: t.assignedTo ? threadHandlerNames.get(t.assignedTo) ?? '—' : '—',
          handlerRole: 'CounselWorks',
        }),
      ),
      timeline: timeline.map((t) => ({
        id: t.id,
        activityType: t.activityType,
        description: t.description,
        actorType: t.actorType,
        createdAt: t.createdAt,
        when: formatRelativeTime(t.createdAt),
      })),
      escalations,
    });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// GET /portal/threads
// ═════════════════════════════════════════════════════════════════════════════
portalRouter.get(
  '/threads',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId, role } = req.firmContext!;

    const scope =
      role === 'attorney' || role === 'managing_attorney'
        ? {
            OR: [
              { createdBy: req.user!.id },
              { case: { primaryAttorneyId: req.user!.id } },
            ],
          }
        : {};

    const threads = await prisma.request.findMany({
      where: { firmId, ...scope },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      include: {
        case: { select: { id: true, clientName: true, caseName: true, matterNumber: true, caseType: true, healthStatus: true } },
      },
      take: 200,
    });

    const handlerIds = threads.map((t) => t.assignedTo).filter((x): x is string => !!x);
    const handlerNames = await loadUserNames(handlerIds);

    const shaped = threads.map((t) =>
      shapeThreadForPortal(t, {
        caseName: t.case ? buildCaseName(t.case) : '',
        handlerName: t.assignedTo ? handlerNames.get(t.assignedTo) ?? '—' : '—',
        handlerRole: 'CounselWorks',
      }),
    );

    res.status(200).json({ threads: shaped });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// GET /portal/threads/:threadId
// ═════════════════════════════════════════════════════════════════════════════
portalRouter.get(
  '/threads/:threadId',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId, role } = req.firmContext!;
    const { threadId } = req.params;

    const thread = await prisma.request.findFirst({
      where: { id: threadId, firmId },
      include: {
        case: {
          select: {
            id: true,
            clientName: true,
            matterNumber: true,
            caseType: true,
            healthStatus: true,
            primaryAttorneyId: true,
          },
        },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!thread) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
      return;
    }

    if (role === 'attorney' || role === 'managing_attorney') {
      const ownsThread = thread.createdBy === req.user!.id;
      const ownsCase = thread.case?.primaryAttorneyId === req.user!.id;
      if (!ownsThread && !ownsCase) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
        return;
      }
    }

    const senderIds = thread.messages.map((m) => m.senderId).filter((x): x is string => !!x);
    const senderNames = await loadUserNames(senderIds);
    const handlerName = thread.assignedTo
      ? (await loadUserNames([thread.assignedTo])).get(thread.assignedTo) ?? '—'
      : '—';

    const hydrated = {
      ...thread,
      messages: thread.messages.map((m) => ({
        ...m,
        senderName: m.senderId ? senderNames.get(m.senderId) ?? 'Unknown' : 'System',
        senderRole: m.senderType === 'system' ? '' : m.senderType,
      })),
    };

    const shaped = shapeThreadForPortal(hydrated, {
      caseName: thread.case ? buildCaseName(thread.case) : '',
      handlerName,
      handlerRole: 'CounselWorks',
    });

    res.status(200).json({ thread: shaped });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// POST /portal/threads — attorney creates a new instruction thread
// ═════════════════════════════════════════════════════════════════════════════
const CreateThreadSchema = z
  .object({
    subject: z.string().min(1).max(500),
    caseId: z.string().uuid().optional(),
    body: z.string().min(1).max(20_000),
    requestType: z
      .enum(['draft_request', 'status_update', 'document_chase', 'records_summary', 'chronology', 'general'])
      .default('general'),
  })
  .strict();

portalRouter.post(
  '/threads',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId, role } = req.firmContext!;

    const body = CreateThreadSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request body.', details: body.error.flatten() },
      });
      return;
    }

    const { subject, caseId, body: messageBody, requestType } = body.data;

    if (caseId) {
      const c = await prisma.case.findFirst({
        where: { id: caseId, firmId, archivedAt: null },
        select: { id: true, primaryAttorneyId: true },
      });
      if (!c) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
        return;
      }
      if ((role === 'attorney' || role === 'managing_attorney') && c.primaryAttorneyId !== req.user!.id) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
        return;
      }
    }

    const thread = await prisma.request.create({
      data: {
        firmId,
        caseId: caseId ?? null,
        createdBy: req.user!.id,
        subject,
        requestType,
        threadKind: 'general',
        priority: 'normal',
        status: 'open',
        lastMessageAt: new Date(),
        messages: {
          create: {
            firmId,
            senderId: req.user!.id,
            senderType: role === 'attorney' || role === 'managing_attorney' ? 'attorney' : 'firm_staff',
            messageKind: 'message',
            body: messageBody,
          },
        },
      },
      include: { messages: true },
    });

    await logActivity({
      firmId,
      actorId: req.user!.id,
      actorType: 'attorney',
      entityType: 'request',
      entityId: thread.id,
      activityType: 'thread_created',
      description: `${req.user!.fullName} opened thread "${subject}"`,
      ipAddress: req.ip,
    });

    if (caseId) {
      // Attorney opening a thread is real activity — re-score the case so the
      // "no activity in 7 days" needs_attention trigger clears and the portal
      // reflects the updated health immediately.
      await logActivity({
        firmId,
        actorId: req.user!.id,
        actorType: 'attorney',
        entityType: 'case',
        entityId: caseId,
        activityType: 'thread_opened_on_case',
        description: `New instruction thread opened: "${subject}"`,
        ipAddress: req.ip,
      });
      await prisma.case.update({
        where: { id: caseId },
        data: { lastActivityAt: new Date() },
      });
      try {
        await recomputeAndPersist(prisma, caseId);
      } catch (err) {
        console.error('[portal] recomputeAndPersist failed after thread create', err);
      }
    }

    // Fire-and-forget AI interpretation. Never awaited — never blocks the
    // HTTP response, never surfaces errors to the attorney. High confidence
    // results will mutate the thread row and post a system acknowledgment
    // message that the portal will render on next fetch.
    console.log(`[portal POST /threads] thread=${thread.id} created — dispatching interpretThreadInBackground`);
    void interpretThreadInBackground({
      firmId,
      threadId: thread.id,
      caseId: caseId ?? null,
      subject,
      messageBody,
      triggeringUserId: req.user!.id,
    });

    res.status(201).json({ threadId: thread.id });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// POST /portal/threads/:threadId/messages
// ═════════════════════════════════════════════════════════════════════════════
const AddMessageSchema = z.object({ body: z.string().min(1).max(20_000) }).strict();

portalRouter.post(
  '/threads/:threadId/messages',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId, role } = req.firmContext!;
    const { threadId } = req.params;

    const parsed = AddMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request body.', details: parsed.error.flatten() },
      });
      return;
    }

    const thread = await prisma.request.findFirst({
      where: { id: threadId, firmId },
      include: { case: { select: { primaryAttorneyId: true } } },
    });
    if (!thread) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
      return;
    }

    if (role === 'attorney' || role === 'managing_attorney') {
      const ownsThread = thread.createdBy === req.user!.id;
      const ownsCase = thread.case?.primaryAttorneyId === req.user!.id;
      if (!ownsThread && !ownsCase) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' } });
        return;
      }
    }

    const senderType =
      role === 'attorney' || role === 'managing_attorney'
        ? 'attorney'
        : role === 'firm_admin' || role === 'case_manager'
        ? 'firm_staff'
        : 'counselworks_staff';

    const message = await prisma.requestMessage.create({
      data: {
        requestId: threadId,
        firmId,
        senderId: req.user!.id,
        senderType,
        messageKind: 'message',
        body: parsed.data.body,
      },
    });

    // Status transitions:
    //   - CW staff replying on a thread   → pending_attorney (attorney owes reply)
    //   - Attorney/firm_staff replying    → in_progress (CW owes reply), and
    //                                        clear closedAt if the thread was auto-closed
    const now = new Date();
    const newStatus =
      senderType === 'attorney' || senderType === 'firm_staff'
        ? 'in_progress'
        : 'pending_attorney';
    await prisma.request.update({
      where: { id: threadId },
      data: {
        lastMessageAt: now,
        status: newStatus,
        closedAt: newStatus === 'in_progress' ? null : thread.closedAt,
      },
    });

    await logActivity({
      firmId,
      actorId: req.user!.id,
      actorType: senderType,
      entityType: 'request',
      entityId: threadId,
      activityType: 'thread_message_sent',
      description: `${req.user!.fullName} replied on "${thread.subject}"`,
      ipAddress: req.ip,
      metadata: { sender_type: senderType, case_id: thread.caseId },
    });

    if (thread.caseId) {
      await prisma.case.update({
        where: { id: thread.caseId },
        data: { lastActivityAt: now },
      });
      try {
        await recomputeAndPersist(prisma, thread.caseId);
      } catch (err) {
        console.error('[portal] recomputeAndPersist failed after message create', err);
      }
    }

    if (senderType === 'attorney' || senderType === 'firm_staff') {
      if (thread.assignedTo) {
        await createNotification({
          firmId,
          userId: thread.assignedTo,
          type: 'message',
          title: 'New attorney message',
          body: `${req.user!.fullName}: ${parsed.data.body.slice(0, 120)}`,
          entityType: 'request',
          entityId: threadId,
        });
      }
    } else {
      await createNotification({
        firmId,
        userId: thread.createdBy,
        type: 'message',
        title: 'Update on your request',
        body: `${req.user!.fullName}: ${parsed.data.body.slice(0, 120)}`,
        entityType: 'request',
        entityId: threadId,
      });
    }

    res.status(201).json({ messageId: message.id });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// GET /portal/drafts
// ═════════════════════════════════════════════════════════════════════════════
portalRouter.get(
  '/drafts',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId, role } = req.firmContext!;

    const caseFilter =
      role === 'attorney' || role === 'managing_attorney'
        ? { case: { primaryAttorneyId: req.user!.id } }
        : {};

    const drafts = await prisma.draft.findMany({
      where: { firmId, archivedAt: null, ...caseFilter },
      orderBy: [{ deliveredAt: 'desc' }, { createdAt: 'desc' }],
      include: {
        case: { select: { id: true, clientName: true, caseName: true, matterNumber: true, caseType: true } },
        qaReviews: {
          where: { status: 'approved' },
          orderBy: { completedAt: 'desc' },
          take: 1,
          select: { reviewerId: true, notes: true, completedAt: true },
        },
      },
      take: 200,
    });

    const preparerIds = drafts.map((d) => d.reviewedBy).filter((x): x is string => !!x);
    const reviewerIds = drafts.flatMap((d) => d.qaReviews.map((q) => q.reviewerId)).filter((x): x is string => !!x);
    const names = await loadUserNames([...preparerIds, ...reviewerIds]);

    const shaped = drafts.map((d) =>
      shapeDraftForPortal(d, {
        caseName: d.case ? buildCaseName(d.case) : '',
        preparedByName: names.get(d.reviewedBy ?? '') ?? '—',
        reviewedByName: names.get(d.qaReviews[0]?.reviewerId ?? '') ?? '—',
        qaScore: d.confidenceScore ?? 0,
      }),
    );

    res.status(200).json({ drafts: shaped });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// GET /portal/documents
// ═════════════════════════════════════════════════════════════════════════════
portalRouter.get(
  '/documents',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId, role } = req.firmContext!;

    const caseFilter =
      role === 'attorney' || role === 'managing_attorney'
        ? { case: { primaryAttorneyId: req.user!.id } }
        : {};

    const files = await prisma.file.findMany({
      where: { firmId, archivedAt: null, ...caseFilter },
      orderBy: { createdAt: 'desc' },
      include: {
        case: { select: { id: true, clientName: true, caseName: true, matterNumber: true, caseType: true, healthStatus: true } },
      },
      take: 300,
    });

    const uploaderIds = files.map((f) => f.uploadedBy).filter((x): x is string => !!x);
    const uploaderNames = await loadUserNames(uploaderIds);

    const shaped = files.map((f) =>
      shapeDocumentForPortal(f, {
        caseName: f.case ? buildCaseName(f.case) : '',
        uploadedByName: uploaderNames.get(f.uploadedBy ?? '') ?? '—',
      }),
    );

    res.status(200).json({ documents: shaped });
  },
);

export { recomputeCaseHealth };
