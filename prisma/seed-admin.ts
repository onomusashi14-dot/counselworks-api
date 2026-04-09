/**
 * prisma/seed-admin.ts
 *
 * Creates the first admin user for CounselWorks OS.
 * This script handles BOTH layers required for login:
 *
 *   1. Supabase Auth  — creates the auth user (email + password)
 *   2. Prisma DB      — creates the users row + firm + firm_memberships row
 *
 * Prerequisites:
 *   - .env file must have: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL
 *   - The SUPABASE_SERVICE_ROLE_KEY is required (not the anon key) because
 *     creating auth users requires admin privileges.
 *
 * Run:
 *   npx ts-node prisma/seed-admin.ts
 *
 * Safe to run multiple times — checks for existing records before creating.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ADMIN_EMAIL    = 'admin@counselworks.com';
const ADMIN_PASSWORD = 'admin123';
const ADMIN_NAME     = 'Admin';
const ADMIN_ROLE     = 'managing_attorney';
const FIRM_NAME      = 'CounselWorks Demo Firm';
const FIRM_SLUG      = 'counselworks-demo';

async function main() {
  const supabaseUrl        = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error(
      '\n❌  Missing environment variables.\n' +
      '   This script requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.\n\n' +
      '   The service role key (NOT the anon key) is needed to create auth users.\n' +
      '   Find it in: Supabase Dashboard → Settings → API → service_role key\n\n' +
      '   Add to your .env:\n' +
      '     SUPABASE_SERVICE_ROLE_KEY="your-service-role-key-here"\n'
    );
    process.exit(1);
  }

  console.log('\n🔧  CounselWorks OS — Admin User Seed\n');

  // ─── STEP 1: Create Supabase Auth user ──────────────────────────────────
  console.log('1. Creating Supabase Auth user...');

  // First check if user already exists
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
      (u: { email: string }) => u.email === ADMIN_EMAIL
    );
    if (existing) {
      authId = existing.id;
      console.log(`   ✓ Supabase Auth user already exists (${authId})`);
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
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        email_confirm: true,     // Skip email verification
        user_metadata: {
          full_name: ADMIN_NAME,
        },
      }),
    });

    if (!createRes.ok) {
      const errBody = await createRes.text();
      console.error(`   ❌ Failed to create Supabase Auth user: ${createRes.status}`);
      console.error(`      ${errBody}`);
      process.exit(1);
    }

    const createData = await createRes.json() as { id: string };
    authId = createData.id;
    console.log(`   ✓ Created Supabase Auth user (${authId})`);
  }

  // ─── STEP 2: Create/update firm in Prisma DB ───────────────────────────
  console.log('2. Creating firm...');

  const firm = await prisma.firm.upsert({
    where: { slug: FIRM_SLUG },
    update: {},
    create: {
      name: FIRM_NAME,
      slug: FIRM_SLUG,
      status: 'active',
    },
  });
  console.log(`   ✓ Firm: ${firm.name} (${firm.id})`);

  // ─── STEP 3: Create/update user in Prisma DB ───────────────────────────
  console.log('3. Creating user record...');

  const user = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { authId, fullName: ADMIN_NAME },
    create: {
      authId,
      email: ADMIN_EMAIL,
      fullName: ADMIN_NAME,
    },
  });
  console.log(`   ✓ User: ${user.fullName} (${user.id})`);

  // ─── STEP 4: Create firm membership ─────────────────────────────────────
  console.log('4. Creating firm membership...');

  await prisma.firmMembership.upsert({
    where: { firmId_userId: { firmId: firm.id, userId: user.id } },
    update: { role: ADMIN_ROLE, isPrimary: true },
    create: {
      firmId: firm.id,
      userId: user.id,
      role: ADMIN_ROLE,
      isPrimary: true,
    },
  });
  console.log(`   ✓ Membership: ${ADMIN_ROLE} at ${FIRM_NAME}`);

  // ─── DONE ───────────────────────────────────────────────────────────────
  console.log('\n✅  Admin user seeded successfully.\n');
  console.log('   Login credentials:');
  console.log(`     Email:    ${ADMIN_EMAIL}`);
  console.log(`     Password: ${ADMIN_PASSWORD}`);
  console.log(`     Role:     ${ADMIN_ROLE}`);
  console.log(`     Firm:     ${FIRM_NAME}\n`);
}

main()
  .catch((e) => {
    console.error('\n❌  Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
