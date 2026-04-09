/**
 * tests/integration/cases.test.ts
 *
 * Phase 2 gate: Cases + Activity Log
 * All requirements from the spec must be proven here.
 *
 * Requires: npm run db:seed (clean state)
 *
 * Proves:
 *  [Role filtering]
 *   1.  managing_attorney sees all firm cases
 *   2.  attorney sees ONLY their assigned cases (not others in same firm)
 *   3.  counselworks_operator sees all cases within permitted firm
 *   4.  counselworks_admin sees all cases across firms
 *   5.  attorney cannot see a case assigned to a different attorney
 *
 *  [Firm isolation]
 *   6.  Firm A user cannot list Firm B cases → 403
 *   7.  Firm A user cannot view a Firm B case via Firm A route → 403
 *   8.  Firm B user cannot view a Firm A case via Firm B route → 403
 *   9.  Unknown case ID returns 403, never 404
 *
 *  [Case mutations — role enforcement]
 *  10.  counselworks_operator can update case phase
 *  11.  counselworks_admin can update case priority
 *  12.  attorney cannot update a case → 403 INSUFFICIENT_ROLE
 *  13.  managing_attorney cannot update a case → 403 INSUFFICIENT_ROLE
 *
 *  [Activity logging]
 *  14.  viewing a case writes case_viewed to activity_log
 *  15.  updating a case writes case_updated to activity_log
 *  16.  activity_log entries never expose ip_address to clients
 *  17.  activity_log entries are immutable (trigger rejects UPDATE)
 *
 *  [Activity timeline]
 *  18.  activity timeline returns entries newest-first
 *  19.  activity timeline is firm-scoped (Firm A user cannot read Firm B timeline)
 *
 *  [Validation]
 *  20.  invalid phase value → 400 VALIDATION_ERROR
 *  21.  invalid query param → 400 VALIDATION_ERROR
 *  22.  empty update body → 400 NO_CHANGES
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/prisma';

// ─── IDs must match prisma/seed.ts exactly ────────────────────────────────────
const FIRM_A_ID    = '11111111-1111-1111-1111-111111111111';
const FIRM_B_ID    = '22222222-2222-2222-2222-222222222222';
const CASE_A1_ID   = '44444444-4444-4444-4444-444444444444'; // primary_attorney = USER_A
const CASE_A2_ID   = '55555555-5555-5555-5555-555555555555'; // primary_attorney = USER_ATT2
const CASE_B1_ID   = '66666666-6666-6666-6666-666666666666'; // Firm B

const AUTH_ID_A    = 'auth-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // managing_attorney Firm A
const AUTH_ID_B    = 'auth-bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // managing_attorney Firm B
const AUTH_ID_CW   = 'auth-cccc-cccc-cccc-cccc-cccccccccccc'; // counselworks_admin
const AUTH_ID_OPS  = 'auth-dddd-dddd-dddd-dddd-dddddddddddd'; // counselworks_operator Firm A
const AUTH_ID_ATT2 = 'auth-eeee-eeee-eeee-eeee-eeeeeeeeeeee'; // attorney Firm A, assigned to CASE_A2

const TEST_SECRET = 'test-jwt-secret-phase-2-gate';

function cookie(authId: string): string {
  const token = jwt.sign({ sub: authId }, TEST_SECRET, { expiresIn: '1h' });
  return `cw_session=${token}`;
}

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
  process.env.NODE_ENV = 'test';
  process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
  app = createApp();

  const [a1, a2, b1] = await Promise.all([
    prisma.case.findUnique({ where: { id: CASE_A1_ID } }),
    prisma.case.findUnique({ where: { id: CASE_A2_ID } }),
    prisma.case.findUnique({ where: { id: CASE_B1_ID } }),
  ]);

  if (!a1 || !a2 || !b1) {
    throw new Error('\nSeed data missing. Run: npm run db:seed\n');
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── HELPER ───────────────────────────────────────────────────────────────────
async function countActivityLog(entityId: string, activityType: string): Promise<number> {
  return prisma.activityLog.count({ where: { entityType: 'case', entityId, activityType } });
}

describe('Phase 2 Gate: Cases + Activity Log', () => {

  // ── Role filtering ─────────────────────────────────────────────────────────
  describe('Role-based case filtering', () => {

    it('1. managing_attorney sees all cases in their firm', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/cases`)
        .set('Cookie', cookie(AUTH_ID_A));

      expect(res.status).toBe(200);
      const ids = res.body.data.cases.map((c: { id: string }) => c.id);
      // managing_attorney sees all Firm A cases — not filtered by primary_attorney_id
      expect(ids).toContain(CASE_A1_ID);
      expect(ids).toContain(CASE_A2_ID);
      expect(ids).not.toContain(CASE_B1_ID);
    });

    it('2. attorney (role=attorney) sees ONLY their assigned cases', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/cases`)
        .set('Cookie', cookie(AUTH_ID_ATT2));

      expect(res.status).toBe(200);
      const ids = res.body.data.cases.map((c: { id: string }) => c.id);
      // USER_ATT2 is primary on CASE_A2 only
      expect(ids).toContain(CASE_A2_ID);
      expect(ids).not.toContain(CASE_A1_ID); // assigned to USER_A, not USER_ATT2
      expect(ids).not.toContain(CASE_B1_ID);
    });

    it('3. counselworks_operator sees ALL cases in their firm', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/cases`)
        .set('Cookie', cookie(AUTH_ID_OPS));

      expect(res.status).toBe(200);
      const ids = res.body.data.cases.map((c: { id: string }) => c.id);
      expect(ids).toContain(CASE_A1_ID);
      expect(ids).toContain(CASE_A2_ID);
      expect(ids).not.toContain(CASE_B1_ID);
    });

    it('4. counselworks_admin sees all cases in Firm A', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/cases`)
        .set('Cookie', cookie(AUTH_ID_CW));

      expect(res.status).toBe(200);
      const ids = res.body.data.cases.map((c: { id: string }) => c.id);
      expect(ids).toContain(CASE_A1_ID);
      expect(ids).toContain(CASE_A2_ID);
    });

    it('5. attorney cannot view a case assigned to a different attorney', async () => {
      // USER_ATT2 tries to view CASE_A1 which belongs to USER_A
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/cases/${CASE_A1_ID}`)
        .set('Cookie', cookie(AUTH_ID_ATT2));

      expect(res.status).toBe(403);
      expect(res.body.data).toBeUndefined();
    });
  });

  // ── Firm isolation ─────────────────────────────────────────────────────────
  describe('Cross-firm isolation', () => {

    it('6. Firm A user cannot list Firm B cases → 403', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_B_ID}/cases`)
        .set('Cookie', cookie(AUTH_ID_A));

      expect(res.status).toBe(403);
      expect(res.body.data).toBeUndefined();
    });

    it('7. Firm A user cannot view Firm B case via Firm A route → 403', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/cases/${CASE_B1_ID}`)
        .set('Cookie', cookie(AUTH_ID_A));

      expect(res.status).toBe(403);
      expect(res.body.data).toBeUndefined();
    });

    it('8. Firm B user cannot view Firm A case via Firm B route → 403', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_B_ID}/cases/${CASE_A1_ID}`)
        .set('Cookie', cookie(AUTH_ID_B));

      expect(res.status).toBe(403);
      expect(res.body.data).toBeUndefined();
    });

    it('9. Unknown case ID → 403, never 404', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/cases/00000000-0000-0000-0000-000000000000`)
        .set('Cookie', cookie(AUTH_ID_A));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ── Case mutations — role enforcement ──────────────────────────────────────
  describe('Case update role enforcement', () => {

    it('10. counselworks_operator can update case phase', async () => {
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/cases/${CASE_A1_ID}`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ phase: 'administration' });

      expect(res.status).toBe(200);
      expect(res.body.data.case.phase).toBe('administration');
    });

    it('11. counselworks_admin can update case priority', async () => {
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/cases/${CASE_A1_ID}`)
        .set('Cookie', cookie(AUTH_ID_CW))
        .send({ priority: 'high' });

      expect(res.status).toBe(200);
      expect(res.body.data.case.priority).toBe('high');
    });

    it('12. attorney CANNOT update a case → 403 INSUFFICIENT_ROLE', async () => {
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/cases/${CASE_A2_ID}`)
        .set('Cookie', cookie(AUTH_ID_ATT2))
        .send({ priority: 'urgent' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('13. managing_attorney CANNOT update a case → 403 INSUFFICIENT_ROLE', async () => {
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/cases/${CASE_A1_ID}`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ priority: 'urgent' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_ROLE');
    });
  });

  // ── Activity logging ───────────────────────────────────────────────────────
  describe('Activity logging', () => {

    it('14. viewing a case writes case_viewed to activity_log', async () => {
      const before = await countActivityLog(CASE_A1_ID, 'case_viewed');

      await request(app)
        .get(`/firms/${FIRM_A_ID}/cases/${CASE_A1_ID}`)
        .set('Cookie', cookie(AUTH_ID_A));

      const after = await countActivityLog(CASE_A1_ID, 'case_viewed');
      expect(after).toBe(before + 1);
    });

    it('15. updating a case writes case_updated to activity_log', async () => {
      const before = await countActivityLog(CASE_A1_ID, 'case_updated');

      await request(app)
        .patch(`/firms/${FIRM_A_ID}/cases/${CASE_A1_ID}`)
        .set('Cookie', cookie(AUTH_ID_CW))
        .send({ priority: 'urgent' });

      const after = await countActivityLog(CASE_A1_ID, 'case_updated');
      expect(after).toBe(before + 1);
    });

    it('16. activity_log entries never expose ip_address to clients', async () => {
      // Ensure there is at least one entry
      await request(app)
        .get(`/firms/${FIRM_A_ID}/cases/${CASE_A1_ID}`)
        .set('Cookie', cookie(AUTH_ID_A));

      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/cases/${CASE_A1_ID}/activity`)
        .set('Cookie', cookie(AUTH_ID_A));

      expect(res.status).toBe(200);
      res.body.data.activity.forEach((entry: Record<string, unknown>) => {
        expect(entry.ipAddress).toBeUndefined();
        expect(entry.ip_address).toBeUndefined();
      });
    });

    it('17. activity_log entries are immutable — DB trigger rejects UPDATE', async () => {
      const entry = await prisma.activityLog.findFirst({
        where: { entityType: 'case', entityId: CASE_A1_ID },
      });

      if (!entry) {
        // Generate one first
        await request(app)
          .get(`/firms/${FIRM_A_ID}/cases/${CASE_A1_ID}`)
          .set('Cookie', cookie(AUTH_ID_A));
      }

      const target = await prisma.activityLog.findFirst({
        where: { entityType: 'case', entityId: CASE_A1_ID },
      });

      expect(target).not.toBeNull();

      await expect(
        prisma.activityLog.update({
          where: { id: target!.id },
          data: { description: 'tampered' },
        })
      ).rejects.toThrow();
    });
  });

  // ── Activity timeline ──────────────────────────────────────────────────────
  describe('Activity timeline', () => {

    it('18. activity timeline returns entries newest-first', async () => {
      // Generate two entries with distinct ordering
      await request(app)
        .get(`/firms/${FIRM_A_ID}/cases/${CASE_A1_ID}`)
        .set('Cookie', cookie(AUTH_ID_A));
      await request(app)
        .get(`/firms/${FIRM_A_ID}/cases/${CASE_A1_ID}`)
        .set('Cookie', cookie(AUTH_ID_A));

      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/cases/${CASE_A1_ID}/activity`)
        .set('Cookie', cookie(AUTH_ID_A));

      expect(res.status).toBe(200);
      const dates = res.body.data.activity.map((e: { createdAt: string }) => new Date(e.createdAt).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
      }
    });

    it('19. activity timeline is firm-scoped — Firm A user cannot read Firm B timeline', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/cases/${CASE_B1_ID}/activity`)
        .set('Cookie', cookie(AUTH_ID_A));

      expect(res.status).toBe(403);
    });
  });

  // ── Validation ─────────────────────────────────────────────────────────────
  describe('Input validation', () => {

    it('20. invalid phase value → 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/cases/${CASE_A1_ID}`)
        .set('Cookie', cookie(AUTH_ID_CW))
        .send({ phase: 'not_a_real_phase' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('21. invalid list query param → 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/cases?phase=made_up`)
        .set('Cookie', cookie(AUTH_ID_A));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('22. empty update body → 400 NO_CHANGES', async () => {
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/cases/${CASE_A1_ID}`)
        .set('Cookie', cookie(AUTH_ID_CW))
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NO_CHANGES');
    });
  });
});
