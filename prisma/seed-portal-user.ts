import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const PORTAL_EMAIL = 'james@counselworks.com';
const PORTAL_PASSWORD = 'CW-demo-2024!';
const PORTAL_NAME = 'James Mitchell';
const PORTAL_ROLE = 'managing_attorney';
const FIRM_A_ID = '11111111-1111-1111-1111-111111111111';
async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
  console.log('Creating Supabase Auth user...');
  const listRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=50`, { headers: { 'Authorization': `Bearer ${supabaseServiceKey}`, 'apikey': supabaseServiceKey } });
  let authId: string | null = null;
  if (listRes.ok) { const d = await listRes.json() as any; const existing = d.users?.find((u: any) => u.email === PORTAL_EMAIL); if (existing) { authId = existing.id; console.log(`Auth user exists (${authId})`); await fetch(`${supabaseUrl}/auth/v1/admin/users/${authId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}`, 'apikey': supabaseServiceKey }, body: JSON.stringify({ password: PORTAL_PASSWORD }) }); } }
  if (!authId) { const r = await fetch(`${supabaseUrl}/auth/v1/admin/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}`, 'apikey': supabaseServiceKey }, body: JSON.stringify({ email: PORTAL_EMAIL, password: PORTAL_PASSWORD, email_confirm: true, user_metadata: { full_name: PORTAL_NAME } }) }); if (!r.ok) { console.error('Failed:', await r.text()); process.exit(1); } const d = await r.json() as any; authId = d.id; console.log(`Created auth user (${authId})`); }
  const firm = await prisma.firm.findUnique({ where: { id: FIRM_A_ID } }); if (!firm) { console.error('Firm not found. Run seed.ts first.'); process.exit(1); }
  const user = await prisma.user.upsert({ where: { email: PORTAL_EMAIL }, update: { authId: authId!, fullName: PORTAL_NAME }, create: { authId: authId!, email: PORTAL_EMAIL, fullName: PORTAL_NAME } });
  await prisma.firmMembership.upsert({ where: { firmId_userId: { firmId: FIRM_A_ID, userId: user.id } }, update: { role: PORTAL_ROLE, isPrimary: true }, create: { firmId: FIRM_A_ID, userId: user.id, role: PORTAL_ROLE, isPrimary: true } });
  console.log(`Done. Login: ${PORTAL_EMAIL} / ${PORTAL_PASSWORD}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
