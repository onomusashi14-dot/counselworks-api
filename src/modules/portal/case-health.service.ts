/**
 * src/modules/portal/case-health.service.ts
 *
 * Business rules for case health status + readiness score.
 *
 *   recomputeAndPersist(prisma, caseId)
 *     Single entry point. Computes both healthStatus and readinessScore,
 *     writes them to the cases row, and returns the result.
 *
 * Health-status rules (highest-priority wins):
 *   BLOCKED:
 *     - any non-archived medical record request with derived escalation
 *       level ≥ 2 (records not received ≥21 days after createdAt), OR
 *     - any MRR explicitly marked status='escalated', OR
 *     - any required ChecklistItem past dueAt and not complete, OR
 *     - any Task in ['open','in_progress'] past its dueAt
 *
 *   NEEDS_ATTENTION (only if not blocked):
 *     - any MRR with derived level = 1 (14–21 days, not received), OR
 *     - any Task in ['open','in_progress'] whose dueAt is within 24 hours, OR
 *     - no ActivityLog entry for this case in the last 7 days, OR
 *     - any Request (thread) in status='pending_attorney' with closedAt null
 *
 *   ON_TRACK otherwise.
 *
 * Readiness score:
 *   Base = percentage of required non-archived ChecklistItems marked complete.
 *   Cap  = 60 when the computed status is 'blocked'. No cap otherwise.
 */

import type { PrismaClient } from '@prisma/client';

export type HealthStatus = 'on_track' | 'needs_attention' | 'blocked';

export interface HealthComputation {
  status: HealthStatus;
  reasons: string[];
  readinessScore: number;
  checklistCompleted: number;
  checklistTotal: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Derive an escalation level from a medical record request's age.
 * Mirrors the day-based ladder used by escalation.service.ts so that a
 * single case can be scored without reading the escalation schedule.
 */
export function deriveMrrEscalationLevel(
  createdAt: Date,
  now: Date = new Date(),
): 0 | 1 | 2 | 3 {
  const days = Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS);
  if (days >= 45) return 3;
  if (days >= 21) return 2;
  if (days >= 14) return 1;
  return 0;
}

export async function computeHealthStatus(
  prisma: PrismaClient,
  caseId: string,
  now: Date = new Date(),
): Promise<{ status: HealthStatus; reasons: string[] }> {
  const reasons: string[] = [];
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // ── BLOCKED probes ────────────────────────────────────────────────────────
  const mrrs = await prisma.medicalRecordRequest.findMany({
    where: { caseId, archivedAt: null, recordsReceivedAt: null },
    select: { id: true, status: true, createdAt: true, providerName: true },
  });

  const blockedMrrs = mrrs.filter(
    (m) =>
      m.status === 'escalated' || deriveMrrEscalationLevel(m.createdAt, now) >= 2,
  );
  if (blockedMrrs.length > 0) {
    reasons.push(
      `${blockedMrrs.length} medical record request${
        blockedMrrs.length === 1 ? '' : 's'
      } escalated (${blockedMrrs.map((m) => m.providerName).join(', ')})`,
    );
  }

  const overdueBlockerChecklist = await prisma.checklistItem.count({
    where: {
      caseId,
      archivedAt: null,
      required: true,
      status: { not: 'complete' },
      dueAt: { lt: now, not: null },
    },
  });
  if (overdueBlockerChecklist > 0) {
    reasons.push(
      `${overdueBlockerChecklist} required checklist item${
        overdueBlockerChecklist === 1 ? '' : 's'
      } past due`,
    );
  }

  const breachedTasks = await prisma.task.count({
    where: {
      caseId,
      archivedAt: null,
      status: { in: ['open', 'in_progress'] },
      dueAt: { lt: now, not: null },
    },
  });
  if (breachedTasks > 0) {
    reasons.push(
      `${breachedTasks} task${breachedTasks === 1 ? '' : 's'} past SLA`,
    );
  }

  if (blockedMrrs.length > 0 || overdueBlockerChecklist > 0 || breachedTasks > 0) {
    return { status: 'blocked', reasons };
  }

  // ── NEEDS_ATTENTION probes ────────────────────────────────────────────────
  const needsMrrs = mrrs.filter(
    (m) => deriveMrrEscalationLevel(m.createdAt, now) === 1,
  );
  if (needsMrrs.length > 0) {
    reasons.push(
      `${needsMrrs.length} medical record request${
        needsMrrs.length === 1 ? '' : 's'
      } aging (14+ days)`,
    );
  }

  const approachingTasks = await prisma.task.count({
    where: {
      caseId,
      archivedAt: null,
      status: { in: ['open', 'in_progress'] },
      dueAt: { gte: now, lte: in24h },
    },
  });
  if (approachingTasks > 0) {
    reasons.push(
      `${approachingTasks} task${approachingTasks === 1 ? '' : 's'} due within 24h`,
    );
  }

  const pendingAttorneyThreads = await prisma.request.count({
    where: {
      caseId,
      status: 'pending_attorney',
      closedAt: null,
    },
  });
  if (pendingAttorneyThreads > 0) {
    reasons.push(
      `${pendingAttorneyThreads} thread${
        pendingAttorneyThreads === 1 ? '' : 's'
      } awaiting attorney review`,
    );
  }

  const recentActivity = await prisma.activityLog.count({
    where: {
      entityType: 'case',
      entityId: caseId,
      createdAt: { gte: sevenDaysAgo },
    },
  });
  if (recentActivity === 0) {
    reasons.push('No activity on this case in the last 7 days');
  }

  if (
    needsMrrs.length > 0 ||
    approachingTasks > 0 ||
    pendingAttorneyThreads > 0 ||
    recentActivity === 0
  ) {
    return { status: 'needs_attention', reasons };
  }

  return { status: 'on_track', reasons: [] };
}

export async function computeReadinessScore(
  prisma: PrismaClient,
  caseId: string,
  healthStatus: HealthStatus,
): Promise<{ score: number; completed: number; total: number }> {
  const [total, completed] = await Promise.all([
    prisma.checklistItem.count({
      where: { caseId, required: true, archivedAt: null },
    }),
    prisma.checklistItem.count({
      where: { caseId, required: true, archivedAt: null, status: 'complete' },
    }),
  ]);

  const base = total === 0 ? 0 : Math.round((completed / total) * 100);
  const capped = healthStatus === 'blocked' ? Math.min(base, 60) : base;
  return { score: capped, completed, total };
}

export async function recomputeAndPersist(
  prisma: PrismaClient,
  caseId: string,
): Promise<HealthComputation> {
  const now = new Date();
  const { status, reasons } = await computeHealthStatus(prisma, caseId, now);
  const { score, completed, total } = await computeReadinessScore(
    prisma,
    caseId,
    status,
  );

  const summary = reasons.length > 0 ? reasons.join(' · ') : null;

  await prisma.case.update({
    where: { id: caseId },
    data: {
      healthStatus: status,
      readinessScore: score,
      healthSummary: summary,
    },
  });

  return {
    status,
    reasons,
    readinessScore: score,
    checklistCompleted: completed,
    checklistTotal: total,
  };
}
