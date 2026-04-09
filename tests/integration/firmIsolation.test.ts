/**
 * tests/integration/firmIsolation.test.ts
 *
 * THE PHASE 1 GATE TEST.
 * All 13 tests must pass before Phase 2 begins.
 *
 * Requires: seeded database (npm run db:seed)
 *
 * What is proven:
 *   1. Health check works
 *   2. Unauthenticated → 401
 *   3. Invalid token → 401
 *   4. Wrong secret → 401
 *   5. Firm A user → Firm A → 200
 *   6. Firm A user → Firm B → 403
 *   7. Firm B user → Firm B → 200
 *   8. Firm B user → Firm A → 403
 *   9. CW Admin → Firm A → 200 (no firm-specific membership needed)
 *  10. CW Admin → Firm B → 200
 *  11. Unknown firm → 403 (never 404)
 *  12. Firm A user sees Firm A members — not Firm B members
 *  13. Firm A user cannot list Firm B members → 403
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/prisma';

// ─── IDs must match prisma/seed.ts exactly ───────────────────────────────────
const FIRM_A_ID  = '11111111-1111-1111-1111-111111111111';
const FIRM_B_ID  = '22222222-2222-2222-2222-222222222222';
const AUTH_ID_A  = 'auth-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AUTH_ID_B  = 'auth-bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const AUTH_ID_CW = 'auth-cccc-cccc-cccc-cccc-cccccccccccc';

const TEST_SECRET = 'test-jwt-secret-phase-1-gate';

function makeSessionCookie(authId: string): string {
  const token = jwt.sign({ sub: authId, email: 'test@test.com' }, TEST_SECRET, { expiresIn: '1h' });
  return `cw_session=${token}`;
}

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
  process.env.NODE_ENV = 'test';
  process.env.ALLOWED_ORIGINS = 'http://localhost:3000';

  app = createApp();

  // Verify seed data exists before running tests
  const [firmA, firmB] = await Promise.all([
    prisma.firm.findUnique({ where: { id: FIRM_A_ID } }),
    prisma.firm.findUnique({ where: { id: FIRM_B_ID } }),
  ]);

  if (!firmA || !firmB) {
    throw new Error(
      '\n\nSeed data missing. Run: npm run db:seed\n' +
      `Missing firms: ${!firmA ? FIRM_A_ID : ''} ${!firmB ? FIRM_B_ID : ''}\n`
    );
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PHASE 1 GATE — Tenant Isolation', () => {

  // ── 1. App health ─────────────────────────────────────────────────────────
  it('1. Health check returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  // ── 2–4. Authentication guards ────────────────────────────────────────────
  it('2. Unauthenticated request → 401', async () => {
    const res = await request(app).get(`/firms/${FIRM_A_ID}`);
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('3. Invalid JWT → 401', async () => {
    const res = await request(app)
      .get(`/firms/${FIRM_A_ID}`)
      .set('Cookie', 'cw_session=this.is.not.valid');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('4. JWT signed with wrong secret → 401', async () => {
    const badToken = jwt.sign({ sub: AUTH_ID_A }, 'wrong-secret', { expiresIn: '1h' });
    const res = await request(app)
      .get(`/firms/${FIRM_A_ID}`)
      .set('Cookie', `cw_session=${badToken}`);
    expect(res.status).toBe(401);
  });

  // ── 5–8. THE CORE ISOLATION TESTS ─────────────────────────────────────────
  it('5. ✓ Firm A user → Firm A → 200', async () => {
    const res = await request(app)
      .get(`/firms/${FIRM_A_ID}`)
      .set('Cookie', makeSessionCookie(AUTH_ID_A));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.firm.id).toBe(FIRM_A_ID);
  });

  it('6. ✗ Firm A user → Firm B → 403', async () => {
    const res = await request(app)
      .get(`/firms/${FIRM_B_ID}`)
      .set('Cookie', makeSessionCookie(AUTH_ID_A));
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.data).toBeUndefined(); // No data leaked
  });

  it('7. ✓ Firm B user → Firm B → 200', async () => {
    const res = await request(app)
      .get(`/firms/${FIRM_B_ID}`)
      .set('Cookie', makeSessionCookie(AUTH_ID_B));
    expect(res.status).toBe(200);
    expect(res.body.data.firm.id).toBe(FIRM_B_ID);
  });

  it('8. ✗ Firm B user → Firm A → 403', async () => {
    const res = await request(app)
      .get(`/firms/${FIRM_A_ID}`)
      .set('Cookie', makeSessionCookie(AUTH_ID_B));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.data).toBeUndefined();
  });

  // ── 9–10. CW Admin cross-firm access ──────────────────────────────────────
  it('9. ✓ CW Admin → Firm A → 200 (no firm membership needed)', async () => {
    const res = await request(app)
      .get(`/firms/${FIRM_A_ID}`)
      .set('Cookie', makeSessionCookie(AUTH_ID_CW));
    expect(res.status).toBe(200);
    expect(res.body.data.firm.id).toBe(FIRM_A_ID);
  });

  it('10. ✓ CW Admin → Firm B → 200', async () => {
    const res = await request(app)
      .get(`/firms/${FIRM_B_ID}`)
      .set('Cookie', makeSessionCookie(AUTH_ID_CW));
    expect(res.status).toBe(200);
    expect(res.body.data.firm.id).toBe(FIRM_B_ID);
  });

  // ── 11. Unknown firm ──────────────────────────────────────────────────────
  it('11. Unknown firm ID → 403, never 404', async () => {
    const unknownId = '00000000-0000-0000-0000-000000000000';
    const res = await request(app)
      .get(`/firms/${unknownId}`)
      .set('Cookie', makeSessionCookie(AUTH_ID_A));
    // 403 — we never confirm whether another firm exists
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  // ── 12–13. Members endpoint isolation ────────────────────────────────────
  it('12. Firm A user sees Firm A members, not Firm B members', async () => {
    const res = await request(app)
      .get(`/firms/${FIRM_A_ID}/members`)
      .set('Cookie', makeSessionCookie(AUTH_ID_A));
    expect(res.status).toBe(200);
    const emails = res.body.data.members.map((m: { email: string }) => m.email);
    expect(emails).toContain('attorney-a@test.counselworks.com');
    expect(emails).not.toContain('attorney-b@test.counselworks.com');
  });

  it('13. Firm A user cannot list Firm B members → 403', async () => {
    const res = await request(app)
      .get(`/firms/${FIRM_B_ID}/members`)
      .set('Cookie', makeSessionCookie(AUTH_ID_A));
    expect(res.status).toBe(403);
  });

});
