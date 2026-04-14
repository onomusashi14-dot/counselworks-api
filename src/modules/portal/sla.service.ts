/**
 * src/modules/portal/sla.service.ts
 *
 * SLA monitoring and breach detection. Runs on the scheduler alongside the
 * escalation engine and thread auto-closer.
 *
 * Two checks:
 *   1. Task SLA breach:
 *      - Any Task in ['open','in_progress'] whose dueAt is in the past.
 *      - Logged as activity_type='sla_breach' with a day-scoped dedupe key so
 *        we don't alert on the same task twice in one day.
 *
 *   2. Attorney response overdue:
 *      - Any Request in status='pending_attorney' whose lastMessageAt is older
 *        than the firm's SLAProfile.threadResponseHrs (default 24h).
 *      - Logged as activity_type='attorney_response_overdue' with a day-scoped
 *        dedupe key.
 *
 * The service does NOT send notifications or emails — it only logs structured
 * breaches that the morning-brief endpoint and dashboard widgets can surface.
 *
 * Cases affected by breaches are re-scored via case-health.service so their
 * healthStatus reflects reality on the next page load.
 */

import type { PrismaClient } from '@prisma/client';
import { logActivity } from '../../utils/auditLog';
import { recomputeAndPersist } from './case-health.service';

const HOUR_MS = 60 * 60 * 1000;

function dayStamp(d: Date): string {
  // YYYY-MM-DD in UTC. Good enough to dedupe once-per-day alerts.
  return d.toISOString().slice(0, 10);
}

async function alreadyLoggedToday(
  prisma: PrismaClient,
  activityType: string,
  dedupeKey: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ c: bigint }>>`
    SELECT count(*)::bigint AS c
    FROM activity_log
    WHERE activity_type = ${activityType}
      AND metadata ->> 'dedupe_key' = ${dedupeKey}
  `;
  return rows[0] && Number(rows[0].c) > 0;
}

export interface SLARunResult {
  tasksChecked: number;
  tasksBreached: number;
  threadsChecked: number;
  threadsOverdue: number;
  casesRecomputed: number;
}

export async function runSLACheck(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<SLARunResult> {
  const result: SLARunResult = {
    tasksChecked: 0,
    tasksBreached: 0,
    threadsChecked: 0,
    threadsOverdue: 0,
    casesRecomputed: 0,
  };
  const day = dayStamp(now);
  const caseIdsToRecompute = new Set<string>();

  // ── 1. Task SLA breaches ──────────────────────────────────────────────────
  const breachedTasks = await prisma.task.findMany({
    where: {
      archivedAt: null,
      status: { in: ['open', 'in_progress'] },
      dueAt: { lt: now, not: null },
    },
    select: {
      id: true,
      firmId: true,
      caseId: true,
      title: true,
      dueAt: true,
      priority: true,
      assignedTo: true,
    },
  });
  result.tasksChecked = breachedTasks.length;

  for (const task of breachedTasks) {
    const dedupeKey = `task:${task.id}:${day}`;
    if (await alreadyLoggedToday(prisma, 'sla_breach', dedupeKey)) continue;

    const hoursOver = task.dueAt
      ? Math.max(1, Math.floor((now.getTime() - task.dueAt.getTime()) / HOUR_MS))
      : 0;

    await logActivity({
      firmId: task.firmId,
      actorType: 'system',
      entityType: 'task',
      entityId: task.id,
      activityType: 'sla_breach',
      description: `Task "${task.title}" is ${hoursOver}h past SLA`,
      metadata: {
        dedupe_key: dedupeKey,
        hours_over: hoursOver,
        priority: task.priority,
        assigned_to: task.assignedTo,
        case_id: task.caseId,
      },
    });

    result.tasksBreached += 1;
    if (task.caseId) caseIdsToRecompute.add(task.caseId);
  }

  // ── 2. Attorney response overdue ──────────────────────────────────────────
  // Default threadResponseHrs = 24. We read it per-firm from SLAProfile so firms
  // with a custom profile get the right window.
  const overdueCutoffDefault = new Date(now.getTime() - 24 * HOUR_MS);
  const staleThreads = await prisma.request.findMany({
    where: {
      status: 'pending_attorney',
      closedAt: null,
      lastMessageAt: { lt: overdueCutoffDefault },
    },
    select: {
      id: true,
      firmId: true,
      caseId: true,
      subject: true,
      lastMessageAt: true,
    },
  });
  result.threadsChecked = staleThreads.length;

  // Cache firm SLA profiles for the in-memory loop.
  const firmIds = Array.from(new Set(staleThreads.map((t) => t.firmId)));
  const slaProfilesByFirm = new Map<string, number>();
  for (const firmId of firmIds) {
    const profile = await prisma.sLAProfile.findFirst({
      where: { firmId, archivedAt: null },
      select: { threadResponseHrs: true },
      orderBy: { createdAt: 'asc' },
    });
    slaProfilesByFirm.set(firmId, profile?.threadResponseHrs ?? 24);
  }

  for (const thread of staleThreads) {
    const slaHours = slaProfilesByFirm.get(thread.firmId) ?? 24;
    const windowMs = slaHours * HOUR_MS;
    if (
      !thread.lastMessageAt ||
      now.getTime() - thread.lastMessageAt.getTime() < windowMs
    ) {
      continue;
    }

    const dedupeKey = `thread:${thread.id}:${day}`;
    if (await alreadyLoggedToday(prisma, 'attorney_response_overdue', dedupeKey)) continue;

    const hoursWaiting = Math.floor(
      (now.getTime() - thread.lastMessageAt.getTime()) / HOUR_MS,
    );

    await logActivity({
      firmId: thread.firmId,
      actorType: 'system',
      entityType: 'request',
      entityId: thread.id,
      activityType: 'attorney_response_overdue',
      description: `Thread "${thread.subject}" waiting on attorney for ${hoursWaiting}h (SLA ${slaHours}h)`,
      metadata: {
        dedupe_key: dedupeKey,
        hours_waiting: hoursWaiting,
        sla_hours: slaHours,
        case_id: thread.caseId,
      },
    });

    result.threadsOverdue += 1;
    if (thread.caseId) caseIdsToRecompute.add(thread.caseId);
  }

  // ── 3. Recompute affected cases so portal reflects new SLA state ──────────
  for (const caseId of caseIdsToRecompute) {
    try {
      await recomputeAndPersist(prisma, caseId);
      result.casesRecomputed += 1;
    } catch (err) {
      console.error('[sla] recomputeAndPersist failed', { caseId, err });
    }
  }

  return result;
}
