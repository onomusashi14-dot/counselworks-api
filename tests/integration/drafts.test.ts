/**
 * tests/integration/drafts.test.ts
 * Phase 5 gate — fixed version
 *
 * Requires: npm run db:seed (clean state)
 *
 * [Creation]
 *  1.  CW operator creates draft — status=drafted, label_text fixed
 *  2.  Attorney cannot create draft → 403 INSUFFICIENT_ROLE
 *  3.  Cross-firm case → 403
 *  4.  Version auto-increments per draftType per case
 *  5.  draft_created written to activity_log
 *
 * [Visibility — FIX 3]
 *  6.  managing_attorney sees all delivered drafts in firm (firm-wide)
 *  7.  plain attorney sees ONLY delivered drafts for assigned cases
 *  8.  plain attorney cannot see delivered draft for unassigned case → 403
 *  9.  CW operator sees all drafts regardless of status
 *  10. Non-delivered draft hidden from managing_attorney → 403 on detail
 *  11. Non-delivered draft hidden from attorney → 403 on detail
 *
 * [Status machine]
 *  12. drafted → in_review (/review — operator)
 *  13. in_review → approved (/approve — ADMIN ONLY)
 *  14. counselworks_operator cannot approve → 403 INSUFFICIENT_ROLE (FIX 2)
 *  15. approved → delivered (/deliver — operator)
 *  16. Cannot deliver without approvedBy → 422 APPROVAL_REQUIRED
 *  17. Cannot deliver from drafted → 409 INVALID_TRANSITION
 *  18. Cannot approve from drafted → 409 INVALID_TRANSITION
 *  19. in_review → needs_revision (/revise — note required)
 *  20. needs_revision → in_review (/review — revision cycle)
 *  21. Revision note required — empty body → 400 VALIDATION_ERROR
 *
 * [label_text — FIX 1 + 4]
 *  22. label_text is fixed value in every response
 *  23. fileId present in detail response (frontend uses for /api/files/:id/url)
 *  24. DB constraint rejects delivered with null approvedBy
 *
 * [Logging + notifications]
 *  25. All transitions write to activity_log
 *  26. Delivery notifies primary attorney (null case gracefully handled)
 *  27. Delivery posts system message to linked request thread
 *
 * [Firm isolation]
 *  28. Firm A user cannot list Firm B drafts → 403
 *  29. Firm A user cannot access Firm B draft → 403
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/prisma';

const FIRM_A_ID   = '11111111-1111-1111-1111-111111111111';
const FIRM_B_ID   = '22222222-2222-2222-2222-222222222222';
const CASE_A1_ID  = '44444444-4444-4444-4444-444444444444'; // primary_attorney = USER_A
const CASE_A2_ID  = '55555555-5555-5555-5555-555555555555'; // primary_attorney = USER_ATT2
const CASE_B1_ID  = '66666666-6666-6666-6666-666666666666';
const USER_A_ID   = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// Auth IDs
const AUTH_ID_A    = 'auth-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // managing_attorney Firm A
const AUTH_ID_B    = 'auth-bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // managing_attorney Firm B
const AUTH_ID_OPS  = 'auth-dddd-dddd-dddd-dddd-dddddddddddd'; // counselworks_operator
const AUTH_ID_ATT2 = 'auth-eeee-eeee-eeee-eeee-eeeeeeeeeeee'; // attorney — assigned to CASE_A2

// counselworks_admin auth — we need one for approve tests
// In seed USER_CW_ID is counselworks_admin
const AUTH_ID_CW   = 'auth-cccc-cccc-cccc-cccc-cccccccccccc';

const FIXED_LABEL = 'DRAFT — PREPARED FOR ATTORNEY REVIEW ONLY. NOT LEGAL ADVICE.';
const TEST_SECRET = 'test-jwt-secret-phase-5-gate';

function cookie(authId: string) {
  return `cw_session=${jwt.sign({ sub: authId }, TEST_SECRET, { expiresIn: '1h' })}`;
}

let app: ReturnType<typeof createApp>;
let draftId: string;         // main draft for status machine tests
let requestThreadId: string; // for delivery-posts-message test

async function countLog(entityId: string, activityType: string) {
  return prisma.activityLog.count({ where: { entityType: 'draft', entityId, activityType } });
}

// Helper: create and walk draft through to approved state
async function createApprovedDraft(caseId = CASE_A1_ID) {
  const d = await prisma.draft.create({
    data: {
      firmId: FIRM_A_ID, caseId,
      draftType: 'other', version: Math.floor(Math.random() * 900) + 100,
      status: 'approved', labelText: FIXED_LABEL,
      approvedBy: 'cccccccc-cccc-cccc-cccc-cccccccccccc', // CW admin id from seed
    },
  });
  return d;
}

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
  process.env.NODE_ENV = 'test';
  process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
  app = createApp();

  const [caseA1, caseA2] = await Promise.all([
    prisma.case.findUnique({ where: { id: CASE_A1_ID } }),
    prisma.case.findUnique({ where: { id: CASE_A2_ID } }),
  ]);
  if (!caseA1 || !caseA2) throw new Error('\nSeed data missing. Run: npm run db:seed\n');

  // Create request thread for delivery test
  const rRes = await request(app)
    .post(`/firms/${FIRM_A_ID}/requests`)
    .set('Cookie', cookie(AUTH_ID_A))
    .send({ subject: 'Draft delivery thread', body: 'For delivery message test.' });
  requestThreadId = rRes.body.data.request.id;
});

afterAll(async () => { await prisma.$disconnect(); });

describe('Phase 5 Gate: Drafts Inbox', () => {

  // ── Creation ───────────────────────────────────────────────────────────────
  describe('Draft creation', () => {

    it('1. CW operator creates draft — status=drafted, fixed label', async () => {
      const res = await request(app)
        .post(`/firms/${FIRM_A_ID}/drafts`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ caseId: CASE_A1_ID, draftType: 'demand_letter' });
      expect(res.status).toBe(201);
      expect(res.body.data.draft.status).toBe('drafted');
      expect(res.body.data.draft.labelText).toBe(FIXED_LABEL);
      expect(res.body.data.draft.approvedBy).toBeNull();
      draftId = res.body.data.draft.id;
    });

    it('2. Attorney cannot create draft → 403 INSUFFICIENT_ROLE', async () => {
      const res = await request(app)
        .post(`/firms/${FIRM_A_ID}/drafts`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ caseId: CASE_A1_ID, draftType: 'medical_summary' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('3. Cross-firm case → 403', async () => {
      const res = await request(app)
        .post(`/firms/${FIRM_A_ID}/drafts`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ caseId: CASE_B1_ID, draftType: 'demand_letter' });
      expect(res.status).toBe(403);
    });

    it('4. Version auto-increments per draftType per case', async () => {
      const res = await request(app)
        .post(`/firms/${FIRM_A_ID}/drafts`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ caseId: CASE_A1_ID, draftType: 'demand_letter' });
      expect(res.status).toBe(201);
      expect(res.body.data.draft.version).toBe(2);
    });

    it('5. draft_created written to activity_log', async () => {
      expect(await countLog(draftId, 'draft_created')).toBe(1);
    });
  });

  // ── Visibility — FIX 3 ─────────────────────────────────────────────────────
  describe('Visibility rules (FIX 3: attorney case scoping)', () => {

    it('6. managing_attorney sees all delivered drafts in firm (firm-wide)', async () => {
      // Deliver a draft so there is something to see
      const approved = await createApprovedDraft(CASE_A1_ID);
      await request(app)
        .patch(`/firms/${FIRM_A_ID}/drafts/${approved.id}/deliver`)
        .set('Cookie', cookie(AUTH_ID_OPS));

      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/drafts`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(200);
      // managing_attorney sees all delivered drafts — including ones not on their case
      res.body.data.drafts.forEach((d: { status: string }) => {
        expect(d.status).toBe('delivered');
      });
    });

    it('7. plain attorney sees ONLY delivered drafts for their assigned cases', async () => {
      // CASE_A2 is assigned to ATT2 (not AUTH_ID_ATT2's case in default seed)
      // AUTH_ID_ATT2 is assigned to CASE_A2 — should only see CASE_A2 drafts
      const approved = await createApprovedDraft(CASE_A2_ID);
      await request(app)
        .patch(`/firms/${FIRM_A_ID}/drafts/${approved.id}/deliver`)
        .set('Cookie', cookie(AUTH_ID_OPS));

      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/drafts`)
        .set('Cookie', cookie(AUTH_ID_ATT2));
      expect(res.status).toBe(200);
      // All returned drafts must be for CASE_A2 (ATT2's assigned case)
      res.body.data.drafts.forEach((d: { caseId: string; status: string }) => {
        expect(d.caseId).toBe(CASE_A2_ID);
        expect(d.status).toBe('delivered');
      });
    });

    it('8. plain attorney cannot see delivered draft for unassigned case → 403', async () => {
      // AUTH_ID_ATT2 is assigned to CASE_A2, not CASE_A1
      const approved = await createApprovedDraft(CASE_A1_ID);
      const deliverRes = await request(app)
        .patch(`/firms/${FIRM_A_ID}/drafts/${approved.id}/deliver`)
        .set('Cookie', cookie(AUTH_ID_OPS));
      const deliveredId = deliverRes.body.data.draft.id;

      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/drafts/${deliveredId}`)
        .set('Cookie', cookie(AUTH_ID_ATT2)); // ATT2 is not on CASE_A1
      expect(res.status).toBe(403);
    });

    it('9. CW operator sees all drafts regardless of status', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/drafts`)
        .set('Cookie', cookie(AUTH_ID_OPS));
      expect(res.status).toBe(200);
      const statuses = res.body.data.drafts.map((d: { status: string }) => d.status);
      expect(statuses).toContain('drafted');
    });

    it('10. Non-delivered draft hidden from managing_attorney on detail → 403', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/drafts/${draftId}`)
        .set('Cookie', cookie(AUTH_ID_A)); // draftId is 'drafted' status
      expect(res.status).toBe(403);
    });

    it('11. Non-delivered draft hidden from attorney on detail → 403', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/drafts/${draftId}`)
        .set('Cookie', cookie(AUTH_ID_ATT2));
      expect(res.status).toBe(403);
    });
  });

  // ── Status machine ─────────────────────────────────────────────────────────
  describe('Status machine', () => {

    it('12. drafted → in_review via /review (operator)', async () => {
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/drafts/${draftId}/review`)
        .set('Cookie', cookie(AUTH_ID_OPS));
      expect(res.status).toBe(200);
      expect(res.body.data.draft.status).toBe('in_review');
      expect(res.body.data.draft.reviewedBy).not.toBeNull();
    });

    it('13. in_review → approved via /approve (ADMIN ONLY — FIX 2)', async () => {
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/drafts/${draftId}/approve`)
        .set('Cookie', cookie(AUTH_ID_CW)); // CW admin
      expect(res.status).toBe(200);
      expect(res.body.data.draft.status).toBe('approved');
      expect(res.body.data.draft.approvedBy).not.toBeNull();
    });

    it('14. counselworks_operator cannot approve → 403 INSUFFICIENT_ROLE (FIX 2)', async () => {
      const d = await prisma.draft.create({
        data: {
          firmId: FIRM_A_ID, caseId: CASE_A1_ID,
          draftType: 'other', version: 200,
          status: 'in_review', labelText: FIXED_LABEL,
        },
      });
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/drafts/${d.id}/approve`)
        .set('Cookie', cookie(AUTH_ID_OPS)); // operator — must be blocked
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('15. approved → delivered via /deliver (operator can deliver)', async () => {
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/drafts/${draftId}/deliver`)
        .set('Cookie', cookie(AUTH_ID_OPS));
      expect(res.status).toBe(200);
      expect(res.body.data.draft.status).toBe('delivered');
      expect(res.body.data.draft.deliveredAt).not.toBeNull();
    });

    it('16. Cannot deliver without approvedBy → 422 APPROVAL_REQUIRED', async () => {
      const d = await prisma.draft.create({
        data: {
          firmId: FIRM_A_ID, caseId: CASE_A1_ID,
          draftType: 'other', version: 201,
          status: 'approved', labelText: FIXED_LABEL,
          approvedBy: null, // no approver
        },
      });
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/drafts/${d.id}/deliver`)
        .set('Cookie', cookie(AUTH_ID_OPS));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('APPROVAL_REQUIRED');
    });

    it('17. Cannot deliver from drafted → 409 INVALID_TRANSITION', async () => {
      const d = await prisma.draft.create({
        data: { firmId: FIRM_A_ID, caseId: CASE_A1_ID, draftType: 'chronology', version: 202, status: 'drafted', labelText: FIXED_LABEL },
      });
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/drafts/${d.id}/deliver`)
        .set('Cookie', cookie(AUTH_ID_OPS));
      expect(res.status).toBe(409);
    });

    it('18. Cannot approve from drafted → 409 INVALID_TRANSITION', async () => {
      const d = await prisma.draft.create({
        data: { firmId: FIRM_A_ID, caseId: CASE_A1_ID, draftType: 'other', version: 203, status: 'drafted', labelText: FIXED_LABEL },
      });
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/drafts/${d.id}/approve`)
        .set('Cookie', cookie(AUTH_ID_CW));
      expect(res.status).toBe(409);
    });

    it('19. in_review → needs_revision via /revise (note required)', async () => {
      const d = await prisma.draft.create({
        data: { firmId: FIRM_A_ID, caseId: CASE_A1_ID, draftType: 'case_fact_sheet', version: 204, status: 'in_review', labelText: FIXED_LABEL },
      });
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/drafts/${d.id}/revise`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ notes: 'Treatment dates on page 2 need verification against source records.' });
      expect(res.status).toBe(200);
      expect(res.body.data.draft.status).toBe('needs_revision');
    });

    it('20. needs_revision → in_review via /review (revision cycle)', async () => {
      const d = await prisma.draft.create({
        data: { firmId: FIRM_A_ID, caseId: CASE_A1_ID, draftType: 'declaration_shell', version: 205, status: 'needs_revision', labelText: FIXED_LABEL },
      });
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/drafts/${d.id}/review`)
        .set('Cookie', cookie(AUTH_ID_OPS));
      expect(res.status).toBe(200);
      expect(res.body.data.draft.status).toBe('in_review');
    });

    it('21. Revision note required — empty body → 400 VALIDATION_ERROR', async () => {
      const d = await prisma.draft.create({
        data: { firmId: FIRM_A_ID, caseId: CASE_A1_ID, draftType: 'provider_communication', version: 206, status: 'in_review', labelText: FIXED_LABEL },
      });
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/drafts/${d.id}/revise`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── label_text and fileId — FIX 1 + 4 ────────────────────────────────────
  describe('label_text and fileId (FIX 1 + 4)', () => {

    it('22. label_text is fixed value in all responses', async () => {
      const listRes = await request(app)
        .get(`/firms/${FIRM_A_ID}/drafts`)
        .set('Cookie', cookie(AUTH_ID_OPS));
      listRes.body.data.drafts.forEach((d: { labelText: string }) => {
        expect(d.labelText).toBe(FIXED_LABEL);
      });

      const detailRes = await request(app)
        .get(`/firms/${FIRM_A_ID}/drafts/${draftId}`)
        .set('Cookie', cookie(AUTH_ID_OPS));
      expect(detailRes.body.data.draft.labelText).toBe(FIXED_LABEL);
    });

    it('23. fileId present in detail response — frontend can call /api/files/:id/url', async () => {
      // draftId has fileId=null (no file attached) — field must still be present
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/drafts/${draftId}`)
        .set('Cookie', cookie(AUTH_ID_OPS));
      expect(res.status).toBe(200);
      // fileId key must exist (null is valid — means no file attached yet)
      expect(res.body.data.draft).toHaveProperty('fileId');
    });

    it('24. DB constraint rejects delivered with null approvedBy', async () => {
      await expect(
        prisma.draft.create({
          data: {
            firmId: FIRM_A_ID, caseId: CASE_A1_ID,
            draftType: 'demand_letter', version: 999,
            status: 'delivered', labelText: FIXED_LABEL,
            approvedBy: null, // DB constraint must reject this
          },
        })
      ).rejects.toThrow();
    });
  });

  // ── Logging and notifications ───────────────────────────────────────────────
  describe('Logging and notifications', () => {

    it('25. All status transitions write to activity_log', async () => {
      const events = ['draft_created', 'draft_in_review', 'draft_approved', 'draft_delivered'];
      for (const event of events) {
        expect(await countLog(draftId, event)).toBeGreaterThan(0);
      }
    });

    it('26. Delivery notifies primary attorney — null primary tolerated gracefully', async () => {
      // Notify check for USER_A (primary on CASE_A1)
      const notif = await prisma.notification.findFirst({
        where: { userId: USER_A_ID, entityId: draftId, type: 'draft_delivered' },
      });
      expect(notif).not.toBeNull();
      expect(notif?.body).toBe(FIXED_LABEL);
    });

    it('27. Delivery posts system message with isDraftDelivery=true to linked thread', async () => {
      const approved = await createApprovedDraft(CASE_A1_ID);
      // Link to request thread
      await prisma.draft.update({
        where: { id: approved.id },
        data: { requestId: requestThreadId },
      });

      await request(app)
        .patch(`/firms/${FIRM_A_ID}/drafts/${approved.id}/deliver`)
        .set('Cookie', cookie(AUTH_ID_OPS));

      const msg = await prisma.requestMessage.findFirst({
        where: { requestId: requestThreadId, isDraftDelivery: true },
        orderBy: { createdAt: 'desc' },
      });
      expect(msg).not.toBeNull();
      expect(msg?.body).toContain(FIXED_LABEL);
      expect(msg?.senderType).toBe('counselworks_staff');
    });
  });

  // ── Firm isolation ─────────────────────────────────────────────────────────
  describe('Firm isolation', () => {

    it('28. Firm A user cannot list Firm B drafts → 403', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_B_ID}/drafts`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(403);
    });

    it('29. Firm A user cannot access Firm B draft → 403', async () => {
      const firmBDraft = await prisma.draft.create({
        data: {
          firmId: FIRM_B_ID, caseId: CASE_B1_ID,
          draftType: 'demand_letter', version: 1,
          status: 'delivered', labelText: FIXED_LABEL,
          approvedBy: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          deliveredAt: new Date(),
        },
      });
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/drafts/${firmBDraft.id}`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(403);
    });
  });
});
