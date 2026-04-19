/**
 * prisma/seed-riverside.ts
 *
 * Seeds "Riverside Legal Group" — a complete demo firm with users, cases,
 * client requests, drafts, and notifications. Intended for the live demo
 * environment so james@counselworks.com (already provisioned by
 * seed-portal-user.ts) and a new attorney user can sign in and exercise
 * every module against realistic data.
 *
 * Status values are mapped to the DB CHECK constraints:
 *   cases.status     ∈ active | on_hold | closed | settled | archived
 *   requests.status  ∈ open | in_progress | pending_attorney | completed | closed
 *   drafts.status    ∈ drafted | in_review | needs_revision | approved | delivered
 *
 * The user-facing "blocked" → on_hold; "new/triaged/assigned/waiting_client"
 * → open/in_progress/in_progress/pending_attorney.
 *
 * Idempotent — every write is an upsert keyed on a stable UUID or unique field,
 * so running twice yields the same database state.
 *
 * Run: npx ts-node prisma/seed-riverside.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─── STABLE IDS ────────────────────────────────────────────────────────────
const FIRM_ID         = '99999999-9999-9999-9999-999999999999';
const ATTORNEY_USER_ID = '88888888-8888-8888-8888-888888888888';

const JAMES_EMAIL    = 'james@counselworks.com';
const ATTORNEY_EMAIL = 'attorney@counselworks.com';
const ATTORNEY_PWD   = 'CW-demo-2024!';
const ATTORNEY_NAME  = 'Sarah Chen';

// Cases — 8 total, varied phase/status/priority
const CASES = [
  { id: 'a0000001-0000-0000-0000-000000000001', matterNumber: 'RLG-2026-0101', clientName: 'Maria Hernandez', caseName: 'Hernandez v. Acme Trucking',     caseType: 'auto_bi',            phase: 'records_collection', status: 'active',  priority: 'high',   readinessScore: 62, healthSummary: 'County General medical records outstanding at Day 18.' },
  { id: 'a0000002-0000-0000-0000-000000000002', matterNumber: 'RLG-2026-0102', clientName: 'Robert Kim',       caseName: 'Kim v. Riverside Mall',           caseType: 'premises_liability', phase: 'demand_prep',        status: 'active',  priority: 'normal', readinessScore: 84, healthSummary: 'Demand letter ready for attorney review.' },
  { id: 'a0000003-0000-0000-0000-000000000003', matterNumber: 'RLG-2026-0103', clientName: 'Sarah Patel',      caseName: 'Patel v. Doe (Rear-End)',         caseType: 'auto_bi',            phase: 'intake',             status: 'active',  priority: 'normal', readinessScore: 22, healthSummary: 'Intake complete; awaiting initial provider list from client.' },
  { id: 'a0000004-0000-0000-0000-000000000004', matterNumber: 'RLG-2026-0104', clientName: 'Daniel Nguyen',    caseName: 'Estate of Nguyen v. Sunset Ridge', caseType: 'wrongful_death',     phase: 'litigation_prep',    status: 'active',  priority: 'urgent', readinessScore: 71, healthSummary: 'Mediation scheduled; expert reports due in 14 days.' },
  { id: 'a0000005-0000-0000-0000-000000000005', matterNumber: 'RLG-2026-0105', clientName: 'Olivia Brooks',    caseName: 'Brooks v. Vargas',                caseType: 'premises_liability', phase: 'administration',     status: 'on_hold', priority: 'normal', readinessScore: 35, healthSummary: 'Client unreachable for 30+ days — case paused pending contact.' },
  { id: 'a0000006-0000-0000-0000-000000000006', matterNumber: 'RLG-2026-0106', clientName: 'Tyrell Washington', caseName: 'Washington v. Bayline Construction', caseType: 'workers_comp',     phase: 'records_collection', status: 'on_hold', priority: 'high',   readinessScore: 41, healthSummary: 'Awaiting employer cooperation on work comp records.' },
  { id: 'a0000007-0000-0000-0000-000000000007', matterNumber: 'RLG-2026-0107', clientName: 'Amelia Foster',    caseName: 'Foster v. Doe (Motorcycle)',      caseType: 'auto_bi',            phase: 'resolved',           status: 'closed',  priority: 'normal', readinessScore: 100, healthSummary: 'Settled — funds disbursed 2026-02-14.' },
  { id: 'a0000008-0000-0000-0000-000000000008', matterNumber: 'RLG-2026-0108', clientName: 'Marcus Reyes',     caseName: 'Reyes v. Bay Surgical Center',    caseType: 'med_mal',            phase: 'resolved',           status: 'closed',  priority: 'normal', readinessScore: 100, healthSummary: 'Confidential settlement reached pre-litigation.' },
];

// Requests — 10 total, varied status (mapped to DB-allowed values)
const REQUESTS = [
  { id: 'b0000001-0000-0000-0000-000000000001', caseIdx: 2, subject: 'New client intake — Patel collision facts',     requestType: 'general',         status: 'open',              priority: 'normal' },
  { id: 'b0000002-0000-0000-0000-000000000002', caseIdx: 0, subject: 'Chase County General for missing imaging',      requestType: 'document_chase',  status: 'open',              priority: 'high'   },
  { id: 'b0000003-0000-0000-0000-000000000003', caseIdx: 1, subject: 'Draft demand for Kim slip-and-fall',            requestType: 'draft_request',   status: 'in_progress',       priority: 'normal' },
  { id: 'b0000004-0000-0000-0000-000000000004', caseIdx: 3, subject: 'Build chronology for Nguyen mediation',         requestType: 'chronology',      status: 'in_progress',       priority: 'urgent' },
  { id: 'b0000005-0000-0000-0000-000000000005', caseIdx: 0, subject: 'Status update — Hernandez records progress',    requestType: 'status_update',   status: 'in_progress',       priority: 'normal' },
  { id: 'b0000006-0000-0000-0000-000000000006', caseIdx: 5, subject: 'Records summary for Washington WC claim',       requestType: 'records_summary', status: 'pending_attorney',  priority: 'high'   },
  { id: 'b0000007-0000-0000-0000-000000000007', caseIdx: 1, subject: 'Confirm policy limits before sending demand',   requestType: 'general',         status: 'pending_attorney',  priority: 'normal' },
  { id: 'b0000008-0000-0000-0000-000000000008', caseIdx: 4, subject: 'Last-known address search for O. Brooks',       requestType: 'general',         status: 'pending_attorney',  priority: 'normal' },
  { id: 'b0000009-0000-0000-0000-000000000009', caseIdx: 6, subject: 'Final case fact sheet — Foster',                requestType: 'general',         status: 'completed',         priority: 'normal' },
  { id: 'b000000a-0000-0000-0000-00000000000a', caseIdx: 7, subject: 'Settlement memo — Reyes med-mal',               requestType: 'general',         status: 'closed',            priority: 'normal' },
];

// Drafts — 5 total. The drafts router only shows non-CW roles (attorney, staff,
// managing_attorney, etc.) drafts at status='delivered'. Two drafts are marked
// delivered so the attorney inbox is non-empty in the demo.
const DRAFTS = [
  { id: 'c0000001-0000-0000-0000-000000000001', caseIdx: 1, requestIdx: 2, draftType: 'demand_letter',          status: 'in_review', confidenceScore: 78, fileName: 'Kim_DemandLetter_v1.docx',           mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 412_672 },
  { id: 'c0000002-0000-0000-0000-000000000002', caseIdx: 3, requestIdx: 3, draftType: 'chronology',             status: 'in_review', confidenceScore: 84, fileName: 'Nguyen_Chronology_v2.pdf',           mime: 'application/pdf',                                                          size: 1_842_176 },
  { id: 'c0000003-0000-0000-0000-000000000003', caseIdx: 5, requestIdx: 5, draftType: 'medical_summary',        status: 'approved',  confidenceScore: 71, fileName: 'Washington_MedSummary_v1.pdf',       mime: 'application/pdf',                                                          size: 967_424 },
  { id: 'c0000004-0000-0000-0000-000000000004', caseIdx: 6, requestIdx: 8, draftType: 'case_fact_sheet',        status: 'delivered', confidenceScore: 92, fileName: 'Foster_CaseFactSheet_FINAL.pdf',     mime: 'application/pdf',                                                          size: 318_976 },
  { id: 'c0000005-0000-0000-0000-000000000005', caseIdx: 0, requestIdx: 4, draftType: 'provider_communication', status: 'delivered', confidenceScore: 88, fileName: 'Hernandez_ProviderRequest_FINAL.pdf', mime: 'application/pdf',                                                          size: 224_768 },
];

async function ensureSupabaseUser(email: string, password: string, name: string): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL!;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const listRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=200`, {
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
  });
  if (listRes.ok) {
    const listData = await listRes.json() as { users?: Array<{ id: string; email: string }> };
    const existing = listData.users?.find((u) => u.email === email);
    if (existing) {
      // Reset password so the documented credentials always work
      await fetch(`${supabaseUrl}/auth/v1/admin/users/${existing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
        body: JSON.stringify({ password }),
      });
      return existing.id;
    }
  }

  const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: name } }),
  });
  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Supabase create failed (${createRes.status}): ${body}`);
  }
  const data = await createRes.json() as { id: string };
  return data.id;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  }

  console.log('\n  CounselWorks — Riverside Legal Group seed\n');

  // ─── FIRM ──────────────────────────────────────────────────────────────
  const firm = await prisma.firm.upsert({
    where: { slug: 'riverside-legal' },
    update: { name: 'Riverside Legal Group', status: 'active' },
    create: {
      id: FIRM_ID,
      name: 'Riverside Legal Group',
      slug: 'riverside-legal',
      status: 'active',
      timezone: 'America/Los_Angeles',
    },
  });
  console.log(`  firm     ${firm.name} (${firm.id})`);

  // ─── ATTORNEY USER (new) ───────────────────────────────────────────────
  const attorneyAuthId = await ensureSupabaseUser(ATTORNEY_EMAIL, ATTORNEY_PWD, ATTORNEY_NAME);
  const attorney = await prisma.user.upsert({
    where: { email: ATTORNEY_EMAIL },
    update: { authId: attorneyAuthId, fullName: ATTORNEY_NAME },
    create: { id: ATTORNEY_USER_ID, authId: attorneyAuthId, email: ATTORNEY_EMAIL, fullName: ATTORNEY_NAME },
  });
  console.log(`  user     ${attorney.fullName} <${attorney.email}>`);

  await prisma.firmMembership.upsert({
    where: { firmId_userId: { firmId: firm.id, userId: attorney.id } },
    update: { role: 'attorney', isPrimary: true, archivedAt: null },
    create: { firmId: firm.id, userId: attorney.id, role: 'attorney', isPrimary: true },
  });

  // ─── JAMES (existing) → add membership in Riverside as primary ─────────
  const james = await prisma.user.findUnique({ where: { email: JAMES_EMAIL } });
  if (!james) {
    throw new Error(`Expected ${JAMES_EMAIL} to exist (run seed-portal-user.ts first).`);
  }
  console.log(`  user     ${james.fullName} <${james.email}>  (existing)`);

  // Make Riverside James's primary firm so /firms/me resolves to it.
  // Other memberships keep their access but lose primary flag.
  await prisma.firmMembership.updateMany({
    where: { userId: james.id, firmId: { not: firm.id } },
    data:  { isPrimary: false },
  });
  await prisma.firmMembership.upsert({
    where: { firmId_userId: { firmId: firm.id, userId: james.id } },
    update: { role: 'staff', isPrimary: true, archivedAt: null },
    create: { firmId: firm.id, userId: james.id, role: 'staff', isPrimary: true },
  });

  // ─── CASES ─────────────────────────────────────────────────────────────
  const caseRecords: Array<{ id: string; matterNumber: string }> = [];
  for (const c of CASES) {
    const rec = await prisma.case.upsert({
      where: { matterNumber: c.matterNumber },
      update: {
        firmId: firm.id, clientName: c.clientName, caseName: c.caseName, caseType: c.caseType,
        phase: c.phase, status: c.status, priority: c.priority,
        readinessScore: c.readinessScore, healthSummary: c.healthSummary,
        primaryAttorneyId: attorney.id, archivedAt: null,
      },
      create: {
        id: c.id, firmId: firm.id, matterNumber: c.matterNumber,
        clientName: c.clientName, caseName: c.caseName, caseType: c.caseType, jurisdiction: 'CA',
        phase: c.phase, status: c.status, priority: c.priority,
        readinessScore: c.readinessScore, healthSummary: c.healthSummary,
        primaryAttorneyId: attorney.id,
      },
    });
    caseRecords.push({ id: rec.id, matterNumber: rec.matterNumber });
  }
  console.log(`  cases    ${caseRecords.length}`);

  // ─── REQUESTS ──────────────────────────────────────────────────────────
  const requestRecords: Array<{ id: string }> = [];
  for (const r of REQUESTS) {
    const target = caseRecords[r.caseIdx];
    const rec = await prisma.request.upsert({
      where: { id: r.id },
      update: {
        firmId: firm.id, caseId: target.id, subject: r.subject,
        requestType: r.requestType, status: r.status, priority: r.priority,
        assignedTo: attorney.id,
      },
      create: {
        id: r.id, firmId: firm.id, caseId: target.id,
        createdBy: james.id, assignedTo: attorney.id,
        subject: r.subject, requestType: r.requestType,
        status: r.status, priority: r.priority,
        lastMessageAt: new Date(),
        closedAt: r.status === 'closed' || r.status === 'completed' ? new Date() : null,
      },
    });
    requestRecords.push({ id: rec.id });
  }
  console.log(`  requests ${requestRecords.length}`);

  // ─── DRAFTS (with backing files) ───────────────────────────────────────
  let draftCount = 0;
  for (const d of DRAFTS) {
    const target = caseRecords[d.caseIdx];
    const storageKey = `firms/${firm.id}/cases/${target.id}/${d.fileName}`;
    const file = await prisma.file.upsert({
      where: { storageKey },
      update: {},
      create: {
        firmId: firm.id, caseId: target.id, uploadedBy: attorney.id,
        originalName: d.fileName, storageKey,
        mimeType: d.mime, sizeBytes: BigInt(d.size),
        documentType: 'demand_draft', status: 'ready', reviewStatus: 'unreviewed',
      },
    });

    const reviewed   = ['in_review', 'approved', 'delivered'].includes(d.status);
    const approved   = ['approved', 'delivered'].includes(d.status);
    const delivered  = d.status === 'delivered';
    await prisma.draft.upsert({
      where: { id: d.id },
      update: {
        firmId: firm.id, caseId: target.id,
        requestId: requestRecords[d.requestIdx].id,
        fileId: file.id, draftType: d.draftType, status: d.status,
        confidenceScore: d.confidenceScore,
        approvedBy: approved ? attorney.id : null,
        reviewedBy: reviewed ? attorney.id : null,
        deliveredAt: delivered ? new Date() : null,
        generatedByAi: true, aiModelUsed: 'claude-opus-4-7',
      },
      create: {
        id: d.id, firmId: firm.id, caseId: target.id,
        requestId: requestRecords[d.requestIdx].id, fileId: file.id,
        draftType: d.draftType, status: d.status, version: 1,
        confidenceScore: d.confidenceScore,
        approvedBy: approved ? attorney.id : null,
        reviewedBy: reviewed ? attorney.id : null,
        deliveredAt: delivered ? new Date() : null,
        generatedByAi: true, aiModelUsed: 'claude-opus-4-7',
      },
    });
    draftCount++;
  }
  console.log(`  drafts   ${draftCount}`);

  // ─── NOTIFICATIONS ─────────────────────────────────────────────────────
  const notifications = [
    { id: 'd0000001-0000-0000-0000-000000000001', userId: james.id, type: 'draft_ready',     title: 'Draft ready for review', body: 'Kim demand letter (v1) is ready for your review.', entityType: 'draft', entityId: DRAFTS[0].id },
    { id: 'd0000002-0000-0000-0000-000000000002', userId: james.id, type: 'request_assigned', title: 'Records request assigned', body: 'Washington WC records summary has been assigned and is in progress.', entityType: 'request', entityId: REQUESTS[5].id },
    { id: 'd0000003-0000-0000-0000-000000000003', userId: attorney.id, type: 'sla_warning',  title: 'SLA approaching', body: 'Hernandez records chase is at Day 18 — escalation suggested.', entityType: 'request', entityId: REQUESTS[1].id },
    { id: 'd0000004-0000-0000-0000-000000000004', userId: attorney.id, type: 'case_update',  title: 'Mediation scheduled', body: 'Nguyen mediation confirmed for next Tuesday.', entityType: 'case', entityId: CASES[3].id },
  ];
  for (const n of notifications) {
    await prisma.notification.upsert({
      where: { id: n.id },
      update: {},
      create: {
        id: n.id, firmId: firm.id, userId: n.userId,
        type: n.type, title: n.title, body: n.body,
        entityType: n.entityType, entityId: n.entityId,
      },
    });
  }
  console.log(`  notifs   ${notifications.length}`);

  console.log('\n  Done.\n');
  console.log('  Logins:');
  console.log(`    ${ATTORNEY_EMAIL} / ${ATTORNEY_PWD}    (role: attorney)`);
  console.log(`    ${JAMES_EMAIL} / CW-demo-2024!    (role: staff, primary firm now Riverside)\n`);
}

main()
  .catch((e) => { console.error('\n  Seed failed:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
