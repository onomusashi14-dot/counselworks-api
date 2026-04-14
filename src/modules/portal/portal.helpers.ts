/**
 * src/modules/portal/portal.helpers.ts
 *
 * Shared helpers for the portal module:
 *   - readinessFromChecklist(caseId)  → Int 0-100 based on checklist_items completion
 *   - healthStatusFromCase(case, blockers) → 'on_track' | 'needs_attention' | 'blocked'
 *   - formatRelativeTime(date)        → "2 hours ago", "yesterday", "3 days ago"
 *   - shapeCaseForPortal(case, ...)   → projection matching frontend Case type
 *   - shapeThreadForPortal(thread)    → projection matching frontend RequestThread type
 *   - shapeDraftForPortal(draft)      → projection matching frontend Draft type
 *   - shapeDocumentForPortal(file)    → projection matching frontend DocumentItem type
 *
 * All shaping functions are pure and do not hit the database. Readiness/health
 * computation helpers take an open prisma client to keep queries batchable.
 */

import type { PrismaClient } from '@prisma/client';

// ─── TYPE EXPORTS (mirror frontend mockData.ts) ───────────────────────────────
export type HealthStatus = 'on_track' | 'needs_attention' | 'blocked';
export type HealthConfidence = 'verified' | 'system_confirmed';

// ─── READINESS SCORE ──────────────────────────────────────────────────────────
// Source of truth: percentage of non-archived, required checklist items marked
// complete for the case. Returns 0 when no checklist exists (phase-appropriate
// for intake). Rounds to nearest integer.
export async function readinessFromChecklist(
  prisma: PrismaClient,
  caseId: string,
): Promise<{ score: number; completed: number; total: number }> {
  const [total, completed] = await Promise.all([
    prisma.checklistItem.count({
      where: { caseId, required: true, archivedAt: null },
    }),
    prisma.checklistItem.count({
      where: { caseId, required: true, archivedAt: null, status: 'complete' },
    }),
  ]);

  if (total === 0) return { score: 0, completed: 0, total: 0 };
  return { score: Math.round((completed / total) * 100), completed, total };
}

// ─── HEALTH STATUS ────────────────────────────────────────────────────────────
// Computation rules (locked — Prompt 2 spec §4):
//   blocked           → any medical_record_request escalated OR any open task
//                       with priority='urgent' past due_at
//   needs_attention   → any medical_record_request overdue (>7 days unfulfilled),
//                       OR any draft in_review/needs_revision older than 48h,
//                       OR any thread with status='ready_for_review' assigned
//                       to the firm attorney
//   on_track          → otherwise
//
// The result is stored on cases.health_status and recomputed whenever case state
// changes (record request updates, task updates, thread status transitions).
// For the portal read path we trust the stored value; the endpoints call
// recomputeCaseHealth() after mutations.
export async function recomputeCaseHealth(
  prisma: PrismaClient,
  caseId: string,
): Promise<HealthStatus> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  // BLOCKED checks
  const [escalatedRecords, overdueUrgentTasks] = await Promise.all([
    prisma.medicalRecordRequest.count({
      where: { caseId, status: 'escalated', archivedAt: null },
    }),
    prisma.task.count({
      where: {
        caseId,
        archivedAt: null,
        status: { in: ['open', 'in_progress'] },
        priority: 'urgent',
        dueAt: { lt: now },
      },
    }),
  ]);

  if (escalatedRecords > 0 || overdueUrgentTasks > 0) {
    await prisma.case.update({
      where: { id: caseId },
      data: { healthStatus: 'blocked' },
    });
    return 'blocked';
  }

  // NEEDS_ATTENTION checks
  const [overdueRecords, staleDrafts, readyThreads] = await Promise.all([
    prisma.medicalRecordRequest.count({
      where: {
        caseId,
        archivedAt: null,
        status: { in: ['pending', 'sent', 'awaiting_response'] },
        createdAt: { lt: sevenDaysAgo },
        recordsReceivedAt: null,
      },
    }),
    prisma.draft.count({
      where: {
        caseId,
        archivedAt: null,
        status: { in: ['in_review', 'needs_revision'] },
        createdAt: { lt: twoDaysAgo },
      },
    }),
    prisma.request.count({
      where: {
        caseId,
        status: 'pending_attorney',
        closedAt: null,
      },
    }),
  ]);

  const status: HealthStatus =
    overdueRecords > 0 || staleDrafts > 0 || readyThreads > 0
      ? 'needs_attention'
      : 'on_track';

  await prisma.case.update({
    where: { id: caseId },
    data: { healthStatus: status },
  });
  return status;
}

// ─── RELATIVE TIME ────────────────────────────────────────────────────────────
export function formatRelativeTime(date: Date | null | undefined): string {
  if (!date) return '—';
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── CASE SHAPING ─────────────────────────────────────────────────────────────
// Matches the Case type in counselworks-portal/src/data/mockData.ts
export function shapeCaseForPortal(
  c: any,
  opts: {
    assignedParalegalName?: string;
    assignedRecordsSpecialistName?: string;
    assignedAttorneyName?: string;
    readinessBasis?: string;
  } = {},
) {
  return {
    id: c.id,
    matterNumber: c.matterNumber,
    caseName: buildCaseName(c),
    clientName: c.clientName,
    // Always humanize — the frontend renders this string verbatim in the case
    // detail header and portfolio table, so raw snake_case values leak through.
    caseType: humanizeCaseType(c.caseType ?? ''),
    jurisdiction: fullJurisdictionName(c.jurisdiction),
    phase: titleCasePhase(c.phase),
    healthStatus: (c.healthStatus ?? 'on_track') as HealthStatus,
    readinessScore: c.readinessScore ?? 0,
    readinessBasis: opts.readinessBasis ?? '',
    healthSummary: c.healthSummary ?? '',
    healthConfidence: 'verified' as HealthConfidence,
    assignedParalegal: opts.assignedParalegalName ?? '—',
    assignedRecordsSpecialist: opts.assignedRecordsSpecialistName ?? '—',
    nextAction: c.nextAction ?? '',
    nextActionEta: c.nextActionDueAt
      ? new Date(c.nextActionDueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : null,
    lastUpdated: formatRelativeTime(c.lastActivityAt ?? c.createdAt),
    assignedAttorney: opts.assignedAttorneyName ?? '—',
  };
}

export function buildCaseName(c: any): string {
  // Prefer a stored case title if we ever add one; else derive from clientName
  // and a humanized case type. (The schema has no caseName column yet — if we
  // add one, return c.caseName first.)
  if (c.caseName && typeof c.caseName === 'string') return c.caseName;
  const type = humanizeCaseType(c.caseType ?? '');
  return type ? `${c.clientName} — ${type}` : c.clientName;
}

export function humanizeCaseType(t: string): string {
  const map: Record<string, string> = {
    employment: 'Employment',
    medical_malpractice: 'Medical Malpractice',
    personal_injury: 'Personal Injury',
    insurance: 'Insurance',
    construction_defect: 'Construction Defect',
    wrongful_termination: 'Wrongful Termination',
    auto_accident: 'Auto Accident',
    premises_liability: 'Premises Liability',
    workers_comp: "Workers' Compensation",
  };
  return map[t] ?? (t ? t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '');
}

function fullJurisdictionName(code: string): string {
  const map: Record<string, string> = {
    CA: 'California', NY: 'New York', TX: 'Texas', FL: 'Florida', WA: 'Washington',
  };
  return map[code] ?? code;
}

function titleCasePhase(phase: string): string {
  return phase
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ─── THREAD SHAPING ───────────────────────────────────────────────────────────
export function shapeThreadForPortal(
  t: any,
  opts: { caseName?: string; handlerName?: string; handlerRole?: string } = {},
) {
  const statusMap: Record<string, string> = {
    open: 'received',
    in_progress: 'in_progress',
    pending_attorney: 'ready_for_review',
    completed: 'completed',
    closed: 'completed',
  };
  const sentenceMap: Record<string, string> = {
    received: 'Received — not yet assigned',
    in_progress: `${opts.handlerName ?? 'Your pod'} is working on this`,
    ready_for_review: 'Ready for your review',
    completed: 'Completed',
  };
  const portalStatus = statusMap[t.status] ?? 'received';

  return {
    id: t.id,
    subject: t.subject,
    caseId: t.caseId ?? '',
    caseName: opts.caseName ?? '',
    handler: opts.handlerName ?? '—',
    handlerRole: opts.handlerRole ?? '',
    status: portalStatus,
    statusSentence: sentenceMap[portalStatus] ?? portalStatus,
    eta: t.eta ? new Date(t.eta).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null,
    healthStatus: (t.case?.healthStatus ?? 'on_track') as HealthStatus,
    lastUpdate: formatRelativeTime(t.lastMessageAt ?? t.createdAt),
    // Fix 4.5: dynamic opened date. Previously the thread detail relied on a
    // hard-coded "Opened" string; now the backend ships the real createdAt so
    // the frontend can format it consistently via Intl.DateTimeFormat.
    createdAt: (t.createdAt instanceof Date ? t.createdAt : new Date(t.createdAt)).toISOString(),
    openedAt: new Date(t.createdAt).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }),
    messages: (t.messages ?? []).map((m: any) => ({
      id: m.id,
      senderName: m.senderName ?? 'Unknown',
      senderRole: m.senderRole ?? '',
      senderType:
        m.senderType === 'attorney' || m.senderType === 'firm_staff'
          ? 'attorney'
          : m.senderType === 'system'
          ? 'system'
          : 'counselworks',
      timestamp: new Date(m.createdAt).toLocaleString('en-US', {
        month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
      }),
      body: m.body,
    })),
  };
}

// ─── DRAFT SHAPING ────────────────────────────────────────────────────────────
export function shapeDraftForPortal(
  d: any,
  opts: {
    caseName?: string;
    preparedByName?: string;
    reviewedByName?: string;
    qaScore?: number;
  } = {},
) {
  const confidence: HealthConfidence =
    (d.confidenceScore ?? 0) >= 90 ? 'verified' : 'system_confirmed';

  return {
    id: d.id,
    draftType: humanizeDraftType(d.draftType),
    caseName: opts.caseName ?? '',
    caseId: d.caseId,
    preparedBy: opts.preparedByName ?? '—',
    reviewedBy: opts.reviewedByName ?? '—',
    qaScore: opts.qaScore ?? d.confidenceScore ?? 0,
    deliveredDate: d.deliveredAt
      ? new Date(d.deliveredAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : 'pending',
    confidence,
  };
}

function humanizeDraftType(t: string): string {
  const map: Record<string, string> = {
    demand_letter: 'Demand Letter',
    medical_summary: 'Medical Records Summary',
    chronology: 'Case Chronology',
    case_fact_sheet: 'Case Fact Sheet',
    client_communication: 'Client Communication',
    provider_communication: 'Provider Communication',
    declaration_shell: 'Declaration Shell',
    other: 'Other',
  };
  return map[t] ?? t;
}

// ─── DOCUMENT SHAPING ─────────────────────────────────────────────────────────
export function shapeDocumentForPortal(
  f: any,
  opts: { caseName?: string; uploadedByName?: string; actionDetail?: string } = {},
) {
  return {
    id: f.id,
    name: f.originalName,
    category: (f.category ?? 'evidence') as string,
    caseName: opts.caseName ?? '',
    caseId: f.caseId ?? '',
    actionState: deriveActionState(f),
    actionDetail: opts.actionDetail ?? deriveActionDetail(f),
    uploadedBy: opts.uploadedByName ?? '—',
    date: f.createdAt
      ? new Date(f.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : '—',
    healthStatus: (f.case?.healthStatus ?? 'on_track') as HealthStatus,
  };
}

function deriveActionState(f: any): string {
  if (f.status === 'missing' && f.reviewStatus === 'escalated') return 'missing_escalated';
  if (f.status === 'missing' && f.reviewStatus === 'follow_up')  return 'missing_followup';
  if (f.status === 'missing')                                     return 'missing_not_requested';
  if (f.reviewStatus === 'used_in_draft')                         return 'used_in_draft';
  if (f.reviewStatus === 'unreviewed' || f.reviewStatus === 'pending') return 'pending_review';
  return 'received';
}

function deriveActionDetail(f: any): string {
  const state = deriveActionState(f);
  switch (state) {
    case 'missing_escalated': return 'Missing — escalated to provider';
    case 'missing_followup':  return 'Missing — follow-up scheduled';
    case 'missing_not_requested': return 'Not yet requested';
    case 'used_in_draft':     return 'Used in draft';
    case 'pending_review':    return 'Pending review';
    default:                  return 'Received';
  }
}
