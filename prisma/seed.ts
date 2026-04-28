/**
 * prisma/seed.ts
 * Deterministic test data. Safe to run multiple times — upserts throughout.
 * Run: npm run db:seed
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─── IDs (keep in sync with all test files) ───────────────────────────────────
export const FIRM_A_ID    = '11111111-1111-1111-1111-111111111111';
export const FIRM_B_ID    = '22222222-2222-2222-2222-222222222222';
export const USER_A_ID    = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // managing_attorney Firm A
export const USER_B_ID    = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // managing_attorney Firm B
export const USER_CW_ID   = 'cccccccc-cccc-cccc-cccc-cccccccccccc'; // counselworks_admin
export const USER_OPS_ID  = 'dddddddd-dddd-dddd-dddd-dddddddddddd'; // counselworks_operator Firm A
export const USER_ATT2_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'; // attorney Firm A (not primary on any case)

export const CASE_A1_ID   = '44444444-4444-4444-4444-444444444444'; // Firm A — assigned to USER_A
export const CASE_A2_ID   = '55555555-5555-5555-5555-555555555555'; // Firm A — assigned to USER_ATT2
export const CASE_B1_ID   = '66666666-6666-6666-6666-666666666666'; // Firm B — assigned to USER_B

// authId values are deliberately mocked Supabase-style subject strings for tests.
// In production these will be real Supabase Auth user IDs (UUIDs).
export const AUTH_ID_A    = 'auth-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const AUTH_ID_B    = 'auth-bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
export const AUTH_ID_CW   = 'auth-cccc-cccc-cccc-cccc-cccccccccccc';
export const AUTH_ID_OPS  = 'auth-dddd-dddd-dddd-dddd-dddddddddddd';
export const AUTH_ID_ATT2 = 'auth-eeee-eeee-eeee-eeee-eeeeeeeeeeee';

async function main() {
  console.log('Seeding...');

  // ─── FIRMS ───────────────────────────────────────────────────────────────
  await prisma.firm.upsert({
    where: { slug: 'okonkwo-mehta' },
    update: {},
    create: { id: FIRM_A_ID, name: 'Okonkwo & Mehta LLP', slug: 'okonkwo-mehta', status: 'active' },
  });

  await prisma.firm.upsert({
    where: { slug: 'rivera-associates' },
    update: {},
    create: { id: FIRM_B_ID, name: 'Rivera & Associates', slug: 'rivera-associates', status: 'active' },
  });

  // ─── USERS ───────────────────────────────────────────────────────────────
  await prisma.user.upsert({
    where: { email: 'attorney-a@test.counselworks.com' },
    update: {},
    create: { id: USER_A_ID, authId: AUTH_ID_A, email: 'attorney-a@test.counselworks.com', fullName: 'R. Okonkwo' },
  });

  await prisma.user.upsert({
    where: { email: 'attorney-b@test.counselworks.com' },
    update: {},
    create: { id: USER_B_ID, authId: AUTH_ID_B, email: 'attorney-b@test.counselworks.com', fullName: 'P. Rivera' },
  });

  await prisma.user.upsert({
    where: { email: 'admin@test.counselworks.com' },
    update: {},
    create: { id: USER_CW_ID, authId: AUTH_ID_CW, email: 'admin@test.counselworks.com', fullName: 'CW Admin' },
  });

  await prisma.user.upsert({
    where: { email: 'ops@test.counselworks.com' },
    update: {},
    create: { id: USER_OPS_ID, authId: AUTH_ID_OPS, email: 'ops@test.counselworks.com', fullName: 'CW Operator' },
  });

  await prisma.user.upsert({
    where: { email: 'attorney-a2@test.counselworks.com' },
    update: {},
    create: { id: USER_ATT2_ID, authId: AUTH_ID_ATT2, email: 'attorney-a2@test.counselworks.com', fullName: 'P. Mehta' },
  });

  // ─── MEMBERSHIPS ─────────────────────────────────────────────────────────
  // USER_A → Firm A — managing_attorney
  await prisma.firmMembership.upsert({
    where: { firmId_userId: { firmId: FIRM_A_ID, userId: USER_A_ID } },
    update: {},
    create: { firmId: FIRM_A_ID, userId: USER_A_ID, role: 'managing_attorney', isPrimary: true },
  });

  // USER_B → Firm B — managing_attorney
  await prisma.firmMembership.upsert({
    where: { firmId_userId: { firmId: FIRM_B_ID, userId: USER_B_ID } },
    update: {},
    create: { firmId: FIRM_B_ID, userId: USER_B_ID, role: 'managing_attorney', isPrimary: true },
  });

  // CW Admin → Firm A (one row needed for global bypass in requireFirmAccess)
  await prisma.firmMembership.upsert({
    where: { firmId_userId: { firmId: FIRM_A_ID, userId: USER_CW_ID } },
    update: {},
    create: { firmId: FIRM_A_ID, userId: USER_CW_ID, role: 'counselworks_admin' },
  });

  // CW Operator → Firm A — counselworks_operator
  await prisma.firmMembership.upsert({
    where: { firmId_userId: { firmId: FIRM_A_ID, userId: USER_OPS_ID } },
    update: {},
    create: { firmId: FIRM_A_ID, userId: USER_OPS_ID, role: 'counselworks_operator' },
  });

  // Second attorney → Firm A — attorney role (not managing)
  await prisma.firmMembership.upsert({
    where: { firmId_userId: { firmId: FIRM_A_ID, userId: USER_ATT2_ID } },
    update: {},
    create: { firmId: FIRM_A_ID, userId: USER_ATT2_ID, role: 'attorney' },
  });

  // ─── CASES ───────────────────────────────────────────────────────────────
  // CASE_A1 — primary attorney is USER_A (Okonkwo)
  await prisma.case.upsert({
    where: { matterNumber: 'CW-2024-0001' },
    update: {},
    create: {
      id: CASE_A1_ID,
      firmId: FIRM_A_ID,
      matterNumber: 'CW-2024-0001',
      clientName: 'Sofia Reyes',
      caseType: 'auto_bi',
      jurisdiction: 'CA',
      phase: 'records_collection',
      status: 'active',
      priority: 'normal',
      readinessScore: 58,
      primaryAttorneyId: USER_A_ID,  // assigned to USER_A
      healthSummary: 'Medical records from County General outstanding at Day 14.',
    },
  });

  // CASE_A2 — primary attorney is USER_ATT2 (Mehta)
  // Used to prove USER_A (Okonkwo) cannot see this case as a plain attorney
  await prisma.case.upsert({
    where: { matterNumber: 'CW-2024-0002' },
    update: {},
    create: {
      id: CASE_A2_ID,
      firmId: FIRM_A_ID,
      matterNumber: 'CW-2024-0002',
      clientName: 'James Okafor',
      caseType: 'auto_bi',
      jurisdiction: 'CA',
      phase: 'demand_prep',
      status: 'active',
      priority: 'high',
      readinessScore: 88,
      primaryAttorneyId: USER_ATT2_ID,  // assigned to USER_ATT2, NOT USER_A
    },
  });

  // CASE_B1 — Firm B
  await prisma.case.upsert({
    where: { matterNumber: 'CW-2024-0003' },
    update: {},
    create: {
      id: CASE_B1_ID,
      firmId: FIRM_B_ID,
      matterNumber: 'CW-2024-0003',
      clientName: 'David Chen',
      caseType: 'premises_liability',
      jurisdiction: 'CA',
      phase: 'intake',
      status: 'active',
      priority: 'normal',
      readinessScore: 20,
      primaryAttorneyId: USER_B_ID,
    },
  });

  console.log('Seed complete.');
  console.log(`  FIRM_A_ID:   ${FIRM_A_ID}  (2 cases)`);
  console.log(`  FIRM_B_ID:   ${FIRM_B_ID}  (1 case)`);
  console.log(`  USER_A:      managing_attorney  → CASE_A1 only`);
  console.log(`  USER_ATT2:   attorney           → CASE_A2 only`);
  console.log(`  USER_OPS:    counselworks_operator → all Firm A cases`);
  console.log(`  USER_CW:     counselworks_admin  → all firms`);
}

main()
  .catch((e) => { console.error('Seed failed:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
