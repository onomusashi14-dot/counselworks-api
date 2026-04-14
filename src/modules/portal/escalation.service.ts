/**
 * src/modules/portal/escalation.service.ts
 *
 * Document (medical records) collection escalation engine.
 *
 * For every open medical record request, this service walks a fixed schedule
 * (day 3 / 7 / 14 / 21 / 30 / 45) and, when a milestone is reached for the
 * first time, it:
 *   - creates a follow-up Task assigned to the records specialist
 *   - writes a structured metadata entry into ActivityLog so we don't repeat
 *   - at day 14+ bumps the MRR status to 'escalated' so recomputeAndPersist()
 *     promotes the case to 'blocked' on the next health pass
 *
 * Idempotency is enforced via ActivityLog metadata keyed by (mrrId, day). The
 * scheduler can call runEscalationCheck() every 15 minutes without producing
 * duplicate tasks.
 *
 * This service only touches medical record requests that are NOT yet received
 * (recordsReceivedAt is null) and NOT archived.
 */

import type { PrismaClient } from '@prisma/client';
import { logActivity } from '../../utils/auditLog';
import { recomputeAndPersist } from './case-health.service';

interface ScheduleRung {
  day: number;
  level: 0 | 1 | 2 | 3;
  action: 'follow_up' | 'escalate' | 'urgent_follow_up' | 'critical';
  priority: 'normal' | 'high' | 'urgent';
  title: (provider: string) => string;
  description: (provider: string) => string;
}

const SCHEDULE: ScheduleRung[] = [
  {
    day: 3,
    level: 0,
    action: 'follow_up',
    priority: 'normal',
    title: (p) => `Follow up with ${p} (day 3)`,
    description: (p) =>
      `Day 3 check on ${p}. Confirm the HITECH request was received and note any fulfillment ETA.`,
  },
  {
    day: 7,
    level: 0,
    action: 'follow_up',
    priority: 'normal',
    title: (p) => `Second follow-up with ${p} (day 7)`,
    description: (p) =>
      `Day 7 check on ${p}. Re-contact provider; escalate to supervisor if unresponsive.`,
  },
  {
    day: 14,
    level: 1,
    action: 'escalate',
    priority: 'high',
    title: (p) => `Escalate ${p} records request`,
    description: (p) =>
      `Day 14: ${p} records still outstanding. Send escalation letter and flag the case.`,
  },
  {
    day: 21,
    level: 2,
    action: 'urgent_follow_up',
    priority: 'urgent',
    title: (p) => `URGENT — ${p} records 21 days overdue`,
    description: (p) =>
      `Day 21: ${p} records are a blocker. Call provider records dept directly today.`,
  },
  {
    day: 30,
    level: 2,
    action: 'urgent_follow_up',
    priority: 'urgent',
    title: (p) => `URGENT — ${p} records 30 days overdue`,
    description: (p) =>
      `Day 30: ${p} records still missing. Consider subpoena or alternate source.`,
  },
  {
    day: 45,
    level: 3,
    action: 'critical',
    priority: 'urgent',
    title: (p) => `CRITICAL — ${p} records 45 days overdue`,
    description: (p) =>
      `Day 45: ${p} records critically overdue. Attorney notification required; evaluate subpoena.`,
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Look up whether we've already processed (mrrId, day) by checking ActivityLog
 * metadata. Dedupe key is an exact match against metadata.escalation_key.
 */
async function alreadyFiredMilestone(
  prisma: PrismaClient,
  mrrId: string,
  day: number,
): Promise<boolean> {
  const key = `${mrrId}:day${day}`;
  // Use raw query because Prisma JSON path filters on jsonb are fine with $queryRaw.
  const rows = await prisma.$queryRaw<Array<{ c: bigint }>>`
    SELECT count(*)::bigint AS c
    FROM activity_log
    WHERE activity_type = 'mrr_escalation_milestone'
      AND metadata ->> 'escalation_key' = ${key}
  `;
  return rows[0] && Number(rows[0].c) > 0;
}

async function findRecordsSpecialist(
  prisma: PrismaClient,
  firmId: string,
): Promise<string | null> {
  const row = await prisma.firmAssignment.findFirst({
    where: { firmId, unassignedAt: null, role: 'records_specialist' },
    select: { cwUserId: true },
  });
  return row?.cwUserId ?? null;
}

export interface EscalationRunResult {
  checked: number;
  firedMilestones: number;
  tasksCreated: number;
  escalated: number;
  casesRecomputed: number;
}

export async function runEscalationCheck(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<EscalationRunResult> {
  const result: EscalationRunResult = {
    checked: 0,
    firedMilestones: 0,
    tasksCreated: 0,
    escalated: 0,
    casesRecomputed: 0,
  };

  const mrrs = await prisma.medicalRecordRequest.findMany({
    where: { archivedAt: null, recordsReceivedAt: null },
    select: {
      id: true,
      firmId: true,
      caseId: true,
      providerName: true,
      status: true,
      createdAt: true,
    },
  });
  result.checked = mrrs.length;

  const caseIdsToRecompute = new Set<string>();

  for (const mrr of mrrs) {
    const ageDays = Math.floor((now.getTime() - mrr.createdAt.getTime()) / DAY_MS);
    // Which rungs have we passed?
    const passedRungs = SCHEDULE.filter((r) => ageDays >= r.day);
    if (passedRungs.length === 0) continue;

    for (const rung of passedRungs) {
      const already = await alreadyFiredMilestone(prisma, mrr.id, rung.day);
      if (already) continue;

      // Create follow-up task
      const assignee = await findRecordsSpecialist(prisma, mrr.firmId);
      const dueAt = new Date(now.getTime() + DAY_MS); // follow-up is due within 24h

      await prisma.task.create({
        data: {
          firmId: mrr.firmId,
          caseId: mrr.caseId,
          title: rung.title(mrr.providerName),
          description: rung.description(mrr.providerName),
          status: 'open',
          priority: rung.priority,
          assignedTo: assignee ?? undefined,
          dueAt,
        },
      });
      result.tasksCreated += 1;

      // Bump MRR status at day 14+
      if (rung.level >= 1 && mrr.status !== 'escalated') {
        await prisma.medicalRecordRequest.update({
          where: { id: mrr.id },
          data: { status: 'escalated' },
        });
        result.escalated += 1;
      }

      // Audit log — serves as dedupe key for subsequent runs
      await logActivity({
        firmId: mrr.firmId,
        actorType: 'system',
        entityType: 'medical_record_request',
        entityId: mrr.id,
        activityType: 'mrr_escalation_milestone',
        description: `Escalation day ${rung.day} fired for ${mrr.providerName} (case ${mrr.caseId})`,
        metadata: {
          escalation_key: `${mrr.id}:day${rung.day}`,
          day: rung.day,
          level: rung.level,
          action: rung.action,
          provider: mrr.providerName,
          case_id: mrr.caseId,
          age_days: ageDays,
        },
      });

      result.firedMilestones += 1;
      caseIdsToRecompute.add(mrr.caseId);
    }
  }

  // Re-score any case we touched so the portal reflects new blockers immediately.
  for (const caseId of caseIdsToRecompute) {
    try {
      await recomputeAndPersist(prisma, caseId);
      result.casesRecomputed += 1;
    } catch (err) {
      console.error('[escalation] recomputeAndPersist failed', { caseId, err });
    }
  }

  return result;
}
