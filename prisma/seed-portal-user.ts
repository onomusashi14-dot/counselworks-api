/**
 * prisma/seed-portal-user.ts
 *
 * Creates the demo portal user "James Mitchell" for CounselWorks OS.
 * Handles BOTH layers:
 *   1. Supabase Auth — creates the auth user (email + password)
 *   2. Prisma DB     — creates/updates user record + firm membership
 *
 * Links the user to the seeded demo firm (FIRM_A_ID = 11111111-...).
 *
 * Prerequisites:
 *   .env must have: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL
 *
 * Run:
 *   npx ts-node prisma/seed-portal-user.ts
 *
 * Safe to run multiple times — checks for existing records.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─── CONFIG ──────────────────────────────────────────────────────────
const PORTAL_EMAIL    = 'james@counselworks.com';
const PORTAL_PASSWORD = 'CW-Demo-2026!';
const PORTAL_NAME     = 'James Mitchell';
const PORTAL_ROLE     = 'managing_attorney';
const FIRM_A_ID       = '11111111-1111-1111-1111-111111111111';

async function main() {
  const supabaseUrl        = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error(
      '\n  Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env\n'
    );
    process.exit(1);
  }

  console.log('\n  CounselWorks OS — Portal User Seed\n');

  // ─── STEP 1: Create Supabase Auth user ────────────────────
  console.log('1. Creating Supabase Auth user...');

  // Check if user already exists
  const listRes = await fetch(
    `${supabaseUrl}/auth/v1/admin/users?page=1&per_page=50`,
    {
      headers: {
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'apikey': supabaseServiceKey,
      },
    }
  );

  let authId: string | null = null;

  if (listRes.ok) {
    const listData = await listRes.json() as { users?: Array<{ id: string; email: string }> };
    const existing = listData.users?.find(
      (u: { email: string }) => u.email === PORTAL_EMAIL
    );
    if (existing) {
      authId = existing.id;
      console.log(`   Supabase Auth user already exists (${authId})`);

      // Update password to ensure it matches
      const updateRes = await fetch(
        `${supabaseUrl}/auth/v1/admin/users/${authId}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
            'apikey': supabaseServiceKey,
          },
          body: JSON.stringify({ password: PORTAL_PASSWORD }),
        }
      );
      if (updateRes.ok) {
        console.log('   Password updated to match seed config.');
      }
    }
  }

  if (!authId) {
    const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'apikey': supabaseServiceKey,
      },
      body: JSON.stringify({
        email: PORTAL_EMAIL,
        password: PORTAL_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: PORTAL_NAME },
      }),
    });

    if (!createRes.ok) {
      const errBody = await createRes.text();
      console.error(`   Failed to create Supabase Auth user: ${createRes.status}`);
      console.error(`   ${errBody}`);
      process.exit(1);
    }

    const createData = await createRes.json() as { id: string };
    authId = createData.id;
    console.log(`   Created Supabase Auth user (${authId})`);
  }

  // ─── STEP 2: Ensure firm exists ──────────────────────────
  console.log('2. Checking firm...');
  const firm = await prisma.firm.findUnique({ where: { id: FIRM_A_ID } });
  if (!firm) {
    console.error(`   Firm ${FIRM_A_ID} not found. Run prisma/seed.ts first.`);
    process.exit(1);
  }
  console.log(`   Firm: ${firm.name} (${firm.id})`);

  // ─── STEP 3: Create/update user in Prisma DB ────────────────
  console.log('3. Creating user record...');
  const user = await prisma.user.upsert({
    where: { email: PORTAL_EMAIL },
    update: { authId: authId!, fullName: PORTAL_NAME },
    create: {
      authId: authId!,
      email: PORTAL_EMAIL,
      fullName: PORTAL_NAME,
    },
  });
  console.log(`   User: ${user.fullName} (${user.id})`);

  // ─── STEP 4: Create firm membership ────────────────────────
  console.log('4. Creating firm membership...');
  await prisma.firmMembership.upsert({
    where: { firmId_userId: { firmId: FIRM_A_ID, userId: user.id } },
    update: { role: PORTAL_ROLE, isPrimary: true },
    create: {
      firmId: FIRM_A_ID,
      userId: user.id,
      role: PORTAL_ROLE,
      isPrimary: true,
    },
  });
  console.log(`   Membership: ${PORTAL_ROLE} at ${firm.name}`);

  // ─── STEP 5: Assign all Firm A cases to James Mitchell ─────────
  console.log('5. Linking Firm A cases to portal user...');
  const caseUpdate = await prisma.case.updateMany({
    where: { firmId: FIRM_A_ID },
    data: { primaryAttorneyId: user.id },
  });
  console.log(`   Updated ${caseUpdate.count} case(s) → primaryAttorneyId = ${user.id}`);

  // ─── STEP 6: Seed demo documents (files + file_links) ──────────
  console.log('6. Seeding demo documents...');

  const CASE_A1_ID = '44444444-4444-4444-4444-444444444444';
  const CASE_A2_ID = '55555555-5555-5555-5555-555555555555';

  const demoFiles = [
    {
      originalName: 'Martinez_MedRecords_CountyGeneral.pdf',
      storageKey:   `firms/${FIRM_A_ID}/cases/${CASE_A1_ID}/Martinez_MedRecords_CountyGeneral.pdf`,
      mimeType:     'application/pdf',
      sizeBytes:    BigInt(2_458_624),
      documentType: 'medical_record',
      caseId:       CASE_A1_ID,
    },
    {
      originalName: 'Martinez_BillingStatement_CountyGeneral.pdf',
      storageKey:   `firms/${FIRM_A_ID}/cases/${CASE_A1_ID}/Martinez_BillingStatement_CountyGeneral.pdf`,
      mimeType:     'application/pdf',
      sizeBytes:    BigInt(845_312),
      documentType: 'billing_record',
      caseId:       CASE_A1_ID,
    },
    {
      originalName: 'Martinez_PoliceReport_LAPD_24-00892.pdf',
      storageKey:   `firms/${FIRM_A_ID}/cases/${CASE_A1_ID}/Martinez_PoliceReport_LAPD_24-00892.pdf`,
      mimeType:     'application/pdf',
      sizeBytes:    BigInt(1_204_736),
      documentType: 'police_report',
      caseId:       CASE_A1_ID,
    },
    {
      originalName: 'Martinez_InsuranceDecPage.pdf',
      storageKey:   `firms/${FIRM_A_ID}/cases/${CASE_A1_ID}/Martinez_InsuranceDecPage.pdf`,
      mimeType:     'application/pdf',
      sizeBytes:    BigInt(312_064),
      documentType: 'insurance',
      caseId:       CASE_A1_ID,
    },
    {
      originalName: 'Okafor_DemandDraft_v2.docx',
      storageKey:   `firms/${FIRM_A_ID}/cases/${CASE_A2_ID}/Okafor_DemandDraft_v2.docx`,
      mimeType:     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes:    BigInt(567_296),
      documentType: 'demand_draft',
      caseId:       CASE_A2_ID,
    },
    {
      originalName: 'Okafor_MedicalChronology.pdf',
      storageKey:   `firms/${FIRM_A_ID}/cases/${CASE_A2_ID}/Okafor_MedicalChronology.pdf`,
      mimeType:     'application/pdf',
      sizeBytes:    BigInt(1_892_352),
      documentType: 'chronology',
      caseId:       CASE_A2_ID,
    },
  ];

  let fileCount = 0;
  for (const doc of demoFiles) {
    // Upsert by storageKey (unique constraint) to stay idempotent
    const file = await prisma.file.upsert({
      where: { storageKey: doc.storageKey },
      update: {},
      create: {
        firmId:       FIRM_A_ID,
        uploadedBy:   user.id,
        originalName: doc.originalName,
        storageKey:   doc.storageKey,
        mimeType:     doc.mimeType,
        sizeBytes:    doc.sizeBytes,
        documentType: doc.documentType,
        status:       'ready',
        reviewStatus: 'unreviewed',
      },
    });

    // Link file to its case (upsert via unique [fileId, entityType, entityId])
    await prisma.fileLink.upsert({
      where: {
        fileId_entityType_entityId: {
          fileId:     file.id,
          entityType: 'case',
          entityId:   doc.caseId,
        },
      },
      update: {},
      create: {
        firmId:     FIRM_A_ID,
        fileId:     file.id,
        entityType: 'case',
        entityId:   doc.caseId,
      },
    });

    fileCount++;
  }
  console.log(`   Created ${fileCount} file(s) with case links`);

  // ─── STEP 7: Seed demo leads (clients + leads) ──────────────────────
  console.log('7. Seeding demo leads...');

  const demoLeads = [
    { fullName: 'Marcus Webb',  email: 'marcus.webb@email.com',  phone: '555-0101', status: 'open',        source: 'web_form'  },
    { fullName: 'Linda Okafor', email: 'linda.okafor@email.com', phone: '555-0102', status: 'in_progress', source: 'referral'  },
    { fullName: 'Derek Hsu',    email: 'derek.hsu@email.com',    phone: '555-0103', status: 'open',        source: 'phone'     },
    { fullName: 'Priya Nair',   email: 'priya.nair@email.com',   phone: '555-0104', status: 'completed',   source: 'web_form'  },
  ];

  let leadCount = 0;
  for (const dl of demoLeads) {
    // Upsert client by email (within firm scope)
    const existingClient = await prisma.client.findFirst({
      where: { firmId: FIRM_A_ID, email: dl.email },
    });

    const client = existingClient ?? await prisma.client.create({
      data: {
        firmId:   FIRM_A_ID,
        fullName: dl.fullName,
        email:    dl.email,
        phone:    dl.phone,
      },
    });

    // Check if a lead already exists for this client in this firm
    const existingLead = await prisma.lead.findFirst({
      where: { firmId: FIRM_A_ID, clientId: client.id },
    });

    if (!existingLead) {
      await prisma.lead.create({
        data: {
          firmId:            FIRM_A_ID,
          clientId:          client.id,
          source:            dl.source,
          stage:             'new',
          status:            dl.status,
          convertedToCaseId: null,
          notes:             null,
        },
      });
      leadCount++;
    } else {
      console.log(`   Lead for ${dl.fullName} already exists, skipping.`);
    }
  }
  console.log(`   Created ${leadCount} new lead(s)`);

  // ─── DONE ────────────────────────────────────────────────────────────
  console.log('\n  Portal user seeded successfully.\n');
  console.log('   Login credentials:');
  console.log(`     Email:    ${PORTAL_EMAIL}`);
  console.log(`     Password: ${PORTAL_PASSWORD}`);
  console.log(`     Role:     ${PORTAL_ROLE}`);
  console.log(`     Firm:     ${firm.name}\n`);
}

main()
  .catch((e) => {
    console.error('\n  Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
