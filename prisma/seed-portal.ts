/**
 * prisma/seed-portal.ts
 *
 * Portal-facing seed data — layered on top of seed.ts. Matches the frontend
 * mock data in counselworks-portal/src/data/mockData.ts so that when the
 * frontend is pointed at the real API, the UI renders identically to the mock.
 *
 * Safe to run multiple times — upserts throughout.
 *
 * Usage:  npx ts-node prisma/seed-portal.ts
 * Or add to package.json as: "db:seed:portal": "ts-node prisma/seed-portal.ts"
 *
 * Depends on seed.ts having already been run (needs FIRM_A_ID + USER_A_ID).
 */

import { PrismaClient } from '@prisma/client';
import { FIRM_A_ID, USER_A_ID } from './seed';

const prisma = new PrismaClient();

// ─── PORTAL USER IDs ──────────────────────────────────────────────────────────
// These become CounselWorks pod members (user_kind='cw') assigned to FIRM_A.
const CW_PARALEGAL_ID   = '10000000-0000-0000-0000-000000000001'; // Maria Santos
const CW_RECORDS_ID     = '10000000-0000-0000-0000-000000000002'; // David Reyes
const CW_QA_ID          = '10000000-0000-0000-0000-000000000003'; // Ana Cruz
const CW_INTAKE_ID      = '10000000-0000-0000-0000-000000000004'; // Sarah Chen
const ATTORNEY_MITCHELL = '10000000-0000-0000-0000-000000000005'; // James Mitchell (firm attorney)

// ─── CASE IDs (match frontend mockData.ts ids c1-c6) ──────────────────────────
const CASE_IDS = {
  c1: '20000000-0000-0000-0000-000000000001', // Martinez v. Pacific Holdings
  c2: '20000000-0000-0000-0000-000000000002', // Thompson v. Riverside Medical
  c3: '20000000-0000-0000-0000-000000000003', // Garcia v. Metro Transit
  c4: '20000000-0000-0000-0000-000000000004', // Baker Estate v. National Ins
  c5: '20000000-0000-0000-0000-000000000005', // Williams v. Apex Construction
  c6: '20000000-0000-0000-0000-000000000006', // Nguyen v. TechStart
};

const THREAD_IDS = {
  t1: '30000000-0000-0000-0000-000000000001',
  t2: '30000000-0000-0000-0000-000000000002',
  t3: '30000000-0000-0000-0000-000000000003',
  t4: '30000000-0000-0000-0000-000000000004',
};

const DRAFT_IDS = {
  d1: '40000000-0000-0000-0000-000000000001',
  d2: '40000000-0000-0000-0000-000000000002',
  d3: '40000000-0000-0000-0000-000000000003',
  d4: '40000000-0000-0000-0000-000000000004',
  d5: '40000000-0000-0000-0000-000000000005',
};

const FILE_IDS = {
  doc1:  '50000000-0000-0000-0000-000000000001',
  doc2:  '50000000-0000-0000-0000-000000000002',
  doc3:  '50000000-0000-0000-0000-000000000003',
  doc4:  '50000000-0000-0000-0000-000000000004',
  doc5:  '50000000-0000-0000-0000-000000000005',
  doc6:  '50000000-0000-0000-0000-000000000006',
  doc7:  '50000000-0000-0000-0000-000000000007',
  doc8:  '50000000-0000-0000-0000-000000000008',
  doc9:  '50000000-0000-0000-0000-000000000009',
  doc10: '50000000-0000-0000-0000-000000000010',
};

async function main() {
  console.log('Seeding portal data...');

  // ─── CW POD USERS ──────────────────────────────────────────────────────────
  const cwUsers = [
    { id: CW_PARALEGAL_ID, email: 'maria.santos@counselworks.com',   fullName: 'Maria Santos',    internalRole: 'lead_case_coordinator' },
    { id: CW_RECORDS_ID,   email: 'david.reyes@counselworks.com',    fullName: 'David Reyes',     internalRole: 'records_specialist' },
    { id: CW_QA_ID,        email: 'ana.cruz@counselworks.com',       fullName: 'Ana Cruz',        internalRole: 'qa_supervisor' },
    { id: CW_INTAKE_ID,    email: 'sarah.chen@counselworks.com',     fullName: 'Sarah Chen',      internalRole: 'intake_specialist' },
  ];
  for (const u of cwUsers) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        id: u.id,
        authId: `auth-${u.id}`,
        email: u.email,
        fullName: u.fullName,
        userKind: 'cw',
        internalRole: u.internalRole,
        lastActiveAt: new Date(Date.now() - 12 * 60_000),
      },
    });
  }

  // ─── FIRM ATTORNEY (James Mitchell) ────────────────────────────────────────
  await prisma.user.upsert({
    where: { email: 'james.mitchell@okonkwo-mehta.com' },
    update: {},
    create: {
      id: ATTORNEY_MITCHELL,
      authId: `auth-${ATTORNEY_MITCHELL}`,
      email: 'james.mitchell@okonkwo-mehta.com',
      fullName: 'James Mitchell',
      userKind: 'firm',
    },
  });
  await prisma.firmMembership.upsert({
    where: { firmId_userId: { firmId: FIRM_A_ID, userId: ATTORNEY_MITCHELL } },
    update: {},
    create: { firmId: FIRM_A_ID, userId: ATTORNEY_MITCHELL, role: 'attorney', isPrimary: true },
  });

  // ─── FIRM ASSIGNMENTS (pod → firm) ─────────────────────────────────────────
  const assignments = [
    { cwUserId: CW_PARALEGAL_ID, role: 'lead_case_coordinator', isPrimary: true  },
    { cwUserId: CW_RECORDS_ID,   role: 'records_specialist',    isPrimary: false },
    { cwUserId: CW_QA_ID,        role: 'qa_supervisor',         isPrimary: false },
    { cwUserId: CW_INTAKE_ID,    role: 'intake_specialist',     isPrimary: false },
  ];
  for (const a of assignments) {
    await prisma.firmAssignment.upsert({
      where: { firmId_cwUserId_role: { firmId: FIRM_A_ID, cwUserId: a.cwUserId, role: a.role } },
      update: {},
      create: { firmId: FIRM_A_ID, cwUserId: a.cwUserId, role: a.role, isPrimary: a.isPrimary },
    });
  }

  // ─── CLIENTS ───────────────────────────────────────────────────────────────
  const clients = [
    { fullName: 'Elena Martinez',  caseKey: 'c1' },
    { fullName: 'David Thompson',  caseKey: 'c2' },
    { fullName: 'Rosa Garcia',     caseKey: 'c3' },
    { fullName: 'Baker Estate',    caseKey: 'c4' },
    { fullName: 'Mark Williams',   caseKey: 'c5' },
    { fullName: 'Linh Nguyen',     caseKey: 'c6' },
  ];
  const clientIdMap: Record<string, string> = {};
  for (const [i, c] of clients.entries()) {
    const id = `60000000-0000-0000-0000-00000000000${i + 1}`;
    clientIdMap[c.caseKey] = id;
    await prisma.client.upsert({
      where: { id },
      update: {},
      create: { id, firmId: FIRM_A_ID, fullName: c.fullName },
    });
  }

  // ─── CASES (6, matching frontend mock) ─────────────────────────────────────
  const cases = [
    {
      id: CASE_IDS.c1, matterNumber: 'CW-2026-0142', clientName: 'Elena Martinez',
      caseName: 'Martinez v. Pacific Holdings LLC',
      caseType: 'employment', phase: 'litigation', status: 'active', priority: 'normal',
      healthStatus: 'on_track', readinessScore: 78,
      healthSummary: 'Discovery proceeding on schedule. HR director deposition Apr 22.',
      nextAction: 'Prep HR director deposition outline — in progress',
      nextActionDueAt: new Date('2026-04-18'),
    },
    {
      id: CASE_IDS.c2, matterNumber: 'CW-2026-0198', clientName: 'David Thompson',
      caseName: 'Thompson v. Riverside Medical Group',
      caseType: 'medical_malpractice', phase: 'records_collection', status: 'active', priority: 'high',
      healthStatus: 'needs_attention', readinessScore: 45,
      healthSummary: 'Case constrained by outstanding medical records from Riverside Medical Group.',
      nextAction: 'Attorney authorization signature required',
      nextActionDueAt: new Date('2026-04-11'),
    },
    {
      id: CASE_IDS.c3, matterNumber: 'CW-2026-0056', clientName: 'Rosa Garcia',
      caseName: 'Garcia v. Metro Transit Authority',
      caseType: 'personal_injury', phase: 'negotiation', status: 'active', priority: 'urgent',
      healthStatus: 'blocked', readinessScore: 62,
      healthSummary: 'Demand preparation paused pending police report from Metro Transit.',
      nextAction: 'Follow up with Metro Transit records custodian',
      nextActionDueAt: new Date('2026-04-11'),
    },
    {
      id: CASE_IDS.c4, matterNumber: 'CW-2026-0210', clientName: 'Baker Estate',
      caseName: 'Baker Estate v. National Insurance Co.',
      caseType: 'insurance', phase: 'intake', status: 'active', priority: 'normal',
      healthStatus: 'on_track', readinessScore: 30,
      healthSummary: 'Intake on track. Policy documents collected.',
      nextAction: 'Submit §2071 claims file request',
      nextActionDueAt: new Date('2026-04-14'),
    },
    {
      id: CASE_IDS.c5, matterNumber: 'CW-2025-0891', clientName: 'Mark Williams',
      caseName: 'Williams v. Apex Construction',
      caseType: 'construction_defect', phase: 'litigation', status: 'active', priority: 'normal',
      healthStatus: 'on_track', readinessScore: 85,
      healthSummary: 'Trial preparation advancing well. Exhibit list and witness outlines assembled.',
      nextAction: 'Finalize trial exhibit binders',
      nextActionDueAt: new Date('2026-04-22'),
    },
    {
      id: CASE_IDS.c6, matterNumber: 'CW-2026-0175', clientName: 'Linh Nguyen',
      caseName: 'Nguyen v. TechStart Inc.',
      caseType: 'wrongful_termination', phase: 'intake', status: 'active', priority: 'normal',
      healthStatus: 'on_track', readinessScore: 52,
      healthSummary: 'Case progressing on schedule. Three key witnesses identified.',
      nextAction: 'Send employment records request',
      nextActionDueAt: new Date('2026-04-11'),
    },
  ];

  for (const c of cases) {
    await prisma.case.upsert({
      where: { matterNumber: c.matterNumber },
      // Allow re-running seed to backfill the caseName column on existing
      // rows. Other columns are left untouched on re-run so manual dev edits
      // (readiness score tweaks, health status toggles, etc.) aren't clobbered.
      update: { caseName: c.caseName },
      create: {
        id: c.id,
        firmId: FIRM_A_ID,
        matterNumber: c.matterNumber,
        clientName: c.clientName,
        caseName: c.caseName,
        clientId: clientIdMap[Object.entries(CASE_IDS).find(([, v]) => v === c.id)![0]],
        caseType: c.caseType,
        jurisdiction: 'CA',
        phase: c.phase,
        status: c.status,
        priority: c.priority,
        healthStatus: c.healthStatus,
        readinessScore: c.readinessScore,
        healthSummary: c.healthSummary,
        nextAction: c.nextAction,
        nextActionDueAt: c.nextActionDueAt,
        lastActivityAt: new Date(Date.now() - 2 * 60 * 60_000),
        primaryAttorneyId: ATTORNEY_MITCHELL,
        assignedCwUserId: CW_PARALEGAL_ID,
      },
    });
  }

  // ─── CHECKLISTS (used by readinessFromChecklist) ──────────────────────────
  // For each case, create N required items and mark M complete so the stored
  // readiness_score equals Math.round(M/N * 100).
  const checklistSpecs = [
    { caseKey: 1, caseId: CASE_IDS.c1, total: 14, done: 11 },
    { caseKey: 2, caseId: CASE_IDS.c2, total: 20, done:  9 },
    { caseKey: 3, caseId: CASE_IDS.c3, total: 19, done: 12 },
    { caseKey: 4, caseId: CASE_IDS.c4, total: 13, done:  4 },
    { caseKey: 5, caseId: CASE_IDS.c5, total: 20, done: 17 },
    { caseKey: 6, caseId: CASE_IDS.c6, total: 15, done:  8 },
  ];
  for (const spec of checklistSpecs) {
    for (let i = 0; i < spec.total; i++) {
      // Deterministic UUID: 70000000-000X-YYYY-0000-000000000000
      // where X = caseKey (1-6) and YYYY = zero-padded item index.
      const id = `70000000-000${spec.caseKey}-${String(i).padStart(4, '0')}-0000-000000000000`;
      await prisma.checklistItem.upsert({
        where: { id },
        update: {},
        create: {
          id,
          firmId: FIRM_A_ID,
          caseId: spec.caseId,
          checklistType: 'discovery',
          label: `Required item ${i + 1}`,
          status: i < spec.done ? 'complete' : 'pending',
          required: true,
          sortOrder: i,
        },
      });
    }
  }

  // ─── THREADS (4, matching frontend mockData.ts) ───────────────────────────
  const threads = [
    {
      id: THREAD_IDS.t1, caseId: CASE_IDS.c2,
      subject: 'Please review authorization form for Thompson records',
      assignedTo: CW_PARALEGAL_ID, status: 'pending_attorney',
      eta: new Date('2026-04-11'),
      createdAt: new Date('2026-04-09T10:15:00Z'),
      messages: [
        {
          senderId: CW_PARALEGAL_ID, senderType: 'counselworks_staff',
          body: "HIPAA authorization form for Riverside Medical Group is ready in the Drafts Inbox for your signature. Once signed, David will submit same day.",
          createdAt: new Date('2026-04-09T10:15:00Z'),
        },
        {
          senderId: null, senderType: 'system',
          body: 'Draft delivered to Drafts Inbox — Thompson Medical Authorization Form.',
          createdAt: new Date('2026-04-09T10:16:00Z'),
        },
      ],
    },
    {
      id: THREAD_IDS.t2, caseId: CASE_IDS.c3,
      subject: 'Escalation update — Metro Transit police report',
      assignedTo: CW_RECORDS_ID, status: 'in_progress',
      eta: new Date('2026-04-11'),
      createdAt: new Date('2026-04-06T09:22:00Z'),
      messages: [
        { senderId: ATTORNEY_MITCHELL, senderType: 'attorney',
          body: 'Where are we on the Metro Transit police report? We need this to finalize the demand.',
          createdAt: new Date('2026-04-06T09:22:00Z') },
        { senderId: null, senderType: 'system',
          body: 'Assigned to David Reyes — Records Specialist.',
          createdAt: new Date('2026-04-06T09:23:00Z') },
        { senderId: CW_RECORDS_ID, senderType: 'counselworks_staff',
          body: 'Initial request Mar 28. Two follow-ups unanswered. Escalated to records office manager directly — callback requested by EOW. Next touchpoint: Apr 11.',
          createdAt: new Date('2026-04-06T14:10:00Z') },
        { senderId: null, senderType: 'system',
          body: 'Escalation logged — Metro Transit records office manager notified. Follow-up Apr 11.',
          createdAt: new Date('2026-04-08T15:45:00Z') },
      ],
    },
    {
      id: THREAD_IDS.t3, caseId: CASE_IDS.c5,
      subject: 'Draft demand package — Williams construction defect',
      assignedTo: CW_PARALEGAL_ID, status: 'in_progress',
      eta: new Date('2026-04-18'),
      createdAt: new Date('2026-04-08T11:00:00Z'),
      messages: [
        { senderId: ATTORNEY_MITCHELL, senderType: 'attorney',
          body: 'Start pulling together the trial demand package for Williams. Focus on the water intrusion expert report as the centerpiece.',
          createdAt: new Date('2026-04-08T11:00:00Z') },
        { senderId: null, senderType: 'system',
          body: 'Instructions received. Assigned to Maria Santos.',
          createdAt: new Date('2026-04-08T11:01:00Z') },
        { senderId: CW_PARALEGAL_ID, senderType: 'counselworks_staff',
          body: 'Working on the demand package. Expert report organized, damages schedule 70% assembled. Target Apr 18 ahead of trial readiness conference.',
          createdAt: new Date('2026-04-09T16:30:00Z') },
      ],
    },
    {
      id: THREAD_IDS.t4, caseId: CASE_IDS.c1,
      subject: 'Questions for Martinez deposition prep',
      assignedTo: CW_PARALEGAL_ID, status: 'completed',
      eta: null, closedAt: new Date('2026-04-07T13:41:00Z'),
      createdAt: new Date('2026-04-05T08:15:00Z'),
      messages: [
        { senderId: ATTORNEY_MITCHELL, senderType: 'attorney',
          body: 'Please put together a deposition outline for the HR director focusing on the retaliation timeline and internal complaint records.',
          createdAt: new Date('2026-04-05T08:15:00Z') },
        { senderId: null, senderType: 'system',
          body: 'Instructions received. Assigned to Maria Santos.',
          createdAt: new Date('2026-04-05T08:16:00Z') },
        { senderId: CW_PARALEGAL_ID, senderType: 'counselworks_staff',
          body: 'Deposition outline complete — 42 questions by theme. Delivered to Drafts Inbox. Ana reviewed, QA score 96.',
          createdAt: new Date('2026-04-07T13:40:00Z') },
        { senderId: null, senderType: 'system',
          body: 'Completed — deposition outline delivered.',
          createdAt: new Date('2026-04-07T13:41:00Z') },
      ],
    },
  ];

  for (const t of threads) {
    await prisma.request.upsert({
      where: { id: t.id },
      update: {},
      create: {
        id: t.id,
        firmId: FIRM_A_ID,
        caseId: t.caseId,
        createdBy: ATTORNEY_MITCHELL,
        assignedTo: t.assignedTo,
        subject: t.subject,
        requestType: 'general',
        threadKind: 'general',
        priority: 'normal',
        status: t.status,
        eta: t.eta ?? null,
        lastMessageAt: t.messages[t.messages.length - 1].createdAt,
        createdAt: t.createdAt,
        closedAt: (t as any).closedAt ?? null,
      },
    });
    for (const m of t.messages) {
      // Avoid dup inserts on re-run by keying on (requestId, createdAt, body-hash)
      const existing = await prisma.requestMessage.findFirst({
        where: { requestId: t.id, createdAt: m.createdAt },
      });
      if (!existing) {
        await prisma.requestMessage.create({
          data: {
            requestId: t.id,
            firmId: FIRM_A_ID,
            senderId: m.senderId,
            senderType: m.senderType,
            messageKind: m.senderType === 'system' ? 'system' : 'message',
            body: m.body,
            createdAt: m.createdAt,
          },
        });
      }
    }
  }

  // ─── DRAFTS ───────────────────────────────────────────────────────────────
  const drafts = [
    { id: DRAFT_IDS.d1, caseId: CASE_IDS.c2, draftType: 'client_communication',
      confidenceScore: 98, deliveredAt: new Date('2026-04-09'),
      approvedBy: ATTORNEY_MITCHELL, reviewedBy: CW_QA_ID, preparedBy: CW_PARALEGAL_ID },
    { id: DRAFT_IDS.d2, caseId: CASE_IDS.c1, draftType: 'declaration_shell',
      confidenceScore: 96, deliveredAt: new Date('2026-04-07'),
      approvedBy: ATTORNEY_MITCHELL, reviewedBy: CW_QA_ID, preparedBy: CW_PARALEGAL_ID },
    { id: DRAFT_IDS.d3, caseId: CASE_IDS.c5, draftType: 'other',
      confidenceScore: 94, deliveredAt: new Date('2026-04-07'),
      approvedBy: ATTORNEY_MITCHELL, reviewedBy: CW_QA_ID, preparedBy: CW_PARALEGAL_ID },
    { id: DRAFT_IDS.d4, caseId: CASE_IDS.c4, draftType: 'provider_communication',
      confidenceScore: 92, deliveredAt: new Date('2026-04-06'),
      approvedBy: ATTORNEY_MITCHELL, reviewedBy: CW_QA_ID, preparedBy: CW_INTAKE_ID },
    { id: DRAFT_IDS.d5, caseId: CASE_IDS.c6, draftType: 'provider_communication',
      confidenceScore: 95, deliveredAt: new Date('2026-04-04'),
      approvedBy: ATTORNEY_MITCHELL, reviewedBy: CW_QA_ID, preparedBy: CW_PARALEGAL_ID },
  ];
  for (const d of drafts) {
    await prisma.draft.upsert({
      where: { id: d.id },
      update: {},
      create: {
        id: d.id,
        firmId: FIRM_A_ID,
        caseId: d.caseId,
        draftType: d.draftType,
        version: 1,
        status: 'delivered',
        confidenceScore: d.confidenceScore,
        generatedByAi: true,
        reviewedBy: d.preparedBy,   // who prepared — kept here for simplicity
        approvedBy: d.approvedBy,
        deliveredAt: d.deliveredAt,
        createdAt: new Date(d.deliveredAt.getTime() - 24 * 60 * 60_000),
      },
    });
    // Attach a QA review row so the reviewedBy lookup in portal.drafts works
    const qaId = `80000000-0000-0000-0000-${d.id.slice(-12)}`;
    await prisma.qAReview.upsert({
      where: { id: qaId },
      update: {},
      create: {
        id: qaId,
        draftId: d.id,
        reviewerId: d.reviewedBy,
        status: 'approved',
        notes: 'QA review complete.',
        completedAt: d.deliveredAt,
      },
    });
  }

  // ─── FILES (10, matching frontend mockData.ts doc1-doc10) ─────────────────
  const files = [
    { id: FILE_IDS.doc1, caseId: CASE_IDS.c1,
      originalName: 'HR Investigation File — Martinez Internal Complaint',
      category: 'evidence', status: 'received', reviewStatus: 'used_in_draft',
      uploadedBy: CW_PARALEGAL_ID, date: new Date('2026-04-06') },
    { id: FILE_IDS.doc2, caseId: CASE_IDS.c1,
      originalName: 'Pacific Holdings Employment Records (2022–2025)',
      category: 'evidence', status: 'received', reviewStatus: 'reviewed',
      uploadedBy: CW_RECORDS_ID, date: new Date('2026-04-05') },
    { id: FILE_IDS.doc3, caseId: CASE_IDS.c2,
      originalName: 'Thompson Medical Records — Riverside Medical',
      category: 'medical', status: 'missing', reviewStatus: 'follow_up',
      uploadedBy: null, date: new Date('2026-04-10') },
    { id: FILE_IDS.doc4, caseId: CASE_IDS.c2,
      originalName: 'Thompson Billing Records — Riverside Medical',
      category: 'billing', status: 'missing', reviewStatus: 'escalated',
      uploadedBy: null, date: new Date('2026-04-10') },
    { id: FILE_IDS.doc5, caseId: CASE_IDS.c3,
      originalName: 'Metro Transit Police Report #MT-2025-8842',
      category: 'court_order', status: 'missing', reviewStatus: 'escalated',
      uploadedBy: null, date: new Date('2026-04-10') },
    { id: FILE_IDS.doc6, caseId: CASE_IDS.c3,
      originalName: 'Garcia Medical Narrative — Dr. Hwang',
      category: 'medical', status: 'received', reviewStatus: 'reviewed',
      uploadedBy: CW_RECORDS_ID, date: new Date('2026-04-03') },
    { id: FILE_IDS.doc7, caseId: CASE_IDS.c4,
      originalName: 'Baker Policy Documents — National Insurance',
      category: 'correspondence', status: 'received', reviewStatus: 'reviewed',
      uploadedBy: CW_INTAKE_ID, date: new Date('2026-04-04') },
    { id: FILE_IDS.doc8, caseId: CASE_IDS.c5,
      originalName: 'Apex Construction Expert Report — Water Intrusion',
      category: 'evidence', status: 'received', reviewStatus: 'used_in_draft',
      uploadedBy: CW_PARALEGAL_ID, date: new Date('2026-04-02') },
    { id: FILE_IDS.doc9, caseId: CASE_IDS.c5,
      originalName: 'Motion in Limine — Williams',
      category: 'pleading', status: 'received', reviewStatus: 'used_in_draft',
      uploadedBy: CW_PARALEGAL_ID, date: new Date('2026-04-07') },
    { id: FILE_IDS.doc10, caseId: CASE_IDS.c6,
      originalName: 'Nguyen Employment Records — TechStart Inc.',
      category: 'evidence', status: 'missing', reviewStatus: 'unreviewed',
      uploadedBy: null, date: new Date('2026-04-10') },
  ];

  for (const f of files) {
    await prisma.file.upsert({
      where: { id: f.id },
      update: {},
      create: {
        id: f.id,
        firmId: FIRM_A_ID,
        caseId: f.caseId,
        uploadedBy: f.uploadedBy,
        originalName: f.originalName,
        storageKey: `seed/${f.id}`,
        mimeType: 'application/pdf',
        sizeBytes: BigInt(0),
        documentType: f.category,
        category: f.category,
        status: f.status,
        reviewStatus: f.reviewStatus,
        createdAt: f.date,
      },
    });
  }

  console.log('Portal seed complete.');
  console.log(`  FIRM_A_ID:      ${FIRM_A_ID}`);
  console.log(`  Attorney:       ${ATTORNEY_MITCHELL} (James Mitchell)`);
  console.log(`  CW pod:         Maria Santos, David Reyes, Ana Cruz, Sarah Chen`);
  console.log(`  Cases:          6 (c1-c6)  |  Threads: 4  |  Drafts: 5  |  Files: 10`);
}

main()
  .catch(e => { console.error('Portal seed failed:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
