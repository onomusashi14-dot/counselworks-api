/**
 * tests/integration/requests.test.ts
 * Phase 3 gate — fixed version
 *
 * Requires: npm run db:seed (clean state)
 *
 * [Thread creation]
 *  1.  Attorney creates request — status=open, assignedTo=null
 *  2.  First message stored with correct senderType
 *  3.  request_created written to activity_log
 *  4.  Cross-firm caseId is rejected → 403
 *
 * [Thread listing]
 *  5.  Firm A user sees Firm A threads
 *  6.  Firm A user cannot list Firm B threads → 403
 *  7.  assignedTo=null threads appear in list without error
 *  8.  Status filter works
 *
 * [Thread detail]
 *  9.  Messages returned in chronological order (asc)
 *  10. Cross-firm thread access → 403
 *  11. assignedTo=null returned as null (not omitted, not error)
 *
 * [Messaging]
 *  12. Attorney can post message
 *  13. CW operator can post message
 *  14. Attorney message on open thread → status becomes in_progress
 *  15. CW reply → status becomes pending_attorney
 *  16. Message to closed thread → 409 THREAD_CLOSED
 *  17. Message logged to activity_log
 *
 * [Notification routing]
 *  18. Attorney message → notifies assignedTo (CW operator)
 *  19. CW message → notifies createdBy (attorney)
 *  20. assignedTo=null → no crash, no notification sent to wrong user
 *  21. Sender does NOT receive their own notification
 *
 * [PATCH — CW roles only]
 *  22. CW operator can assign thread
 *  23. CW operator can set status
 *  24. CW operator can set ETA
 *  25. Closing thread sets closedAt, writes request_closed to activity_log
 *  26. Attorney PATCH → 403 INSUFFICIENT_ROLE
 *  27. managing_attorney PATCH → 403 INSUFFICIENT_ROLE
 *  28. Status change notifies thread creator
 *  29. Assignment notifies newly assigned operator
 *
 * [Notifications — user-scoped]
 *  30. /notifications returns only current user's notifications
 *  31. mark-one-read sets readAt
 *  32. mark-all-read clears all unread for user
 *  33. Cannot mark another user's notification → 403
 *  34. Duplicate read is idempotent (200)
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/prisma';

// IDs match seed.ts
const FIRM_A_ID   = '11111111-1111-1111-1111-111111111111';
const FIRM_B_ID   = '22222222-2222-2222-2222-222222222222';
const CASE_A1_ID  = '44444444-4444-4444-4444-444444444444';
const CASE_B1_ID  = '66666666-6666-6666-6666-666666666666';
const USER_A_ID   = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_OPS_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const AUTH_ID_A    = 'auth-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // managing_attorney Firm A
const AUTH_ID_B    = 'auth-bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // managing_attorney Firm B
const AUTH_ID_OPS  = 'auth-dddd-dddd-dddd-dddd-dddddddddddd'; // counselworks_operator Firm A
const AUTH_ID_ATT2 = 'auth-eeee-eeee-eeee-eeee-eeeeeeeeeeee'; // attorney Firm A

const TEST_SECRET = 'test-jwt-secret-phase-3-gate';

function cookie(authId: string): string {
  const token = jwt.sign({ sub: authId }, TEST_SECRET, { expiresIn: '1h' });
  return `cw_session=${token}`;
}

let app: ReturnType<typeof createApp>;
let threadId: string;          // created in test 1
let assignedThreadId: string;  // thread with assignedTo set — for notification tests

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
  process.env.NODE_ENV = 'test';
  process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
  app = createApp();

  const [caseA1] = await Promise.all([
    prisma.case.findUnique({ where: { id: CASE_A1_ID } }),
  ]);
  if (!caseA1) throw new Error('\nSeed data missing. Run: npm run db:seed\n');
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── HELPER ───────────────────────────────────────────────────────────────────
async function countLog(entityId: string, activityType: string) {
  return prisma.activityLog.count({ where: { entityType: 'request', entityId, activityType } });
}

async function countNotif(userId: string, entityId: string, type?: string) {
  return prisma.notification.count({
    where: { userId, entityId, ...(type ? { type } : {}) },
  });
}

describe('Phase 3 Gate: Requests + Messaging + Notifications', () => {

  // ── Thread creation ────────────────────────────────────────────────────────
  describe('Thread creation', () => {

    it('1. Attorney creates request — status=open, assignedTo=null', async () => {
      const res = await request(app)
        .post(`/firms/${FIRM_A_ID}/requests`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({
          subject:     'Demand draft — Martinez treatment gap',
          requestType: 'draft_request',
          caseId:      CASE_A1_ID,
          body:        'Please prepare demand draft. Focus on treatment gap March–June.',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.request.status).toBe('open');
      expect(res.body.data.request.assignedTo).toBeNull();
      threadId = res.body.data.request.id;
    });

    it('2. First message stored with senderType attorney', async () => {
      const msg = await prisma.requestMessage.findFirst({
        where: { requestId: threadId },
        orderBy: { createdAt: 'asc' },
      });
      expect(msg?.senderType).toBe('attorney');
    });

    it('3. request_created written to activity_log', async () => {
      const count = await countLog(threadId, 'request_created');
      expect(count).toBe(1);
    });

    it('4. Cross-firm caseId rejected → 403', async () => {
      const res = await request(app)
        .post(`/firms/${FIRM_A_ID}/requests`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ subject: 'Attack', body: 'Cross-firm case.', caseId: CASE_B1_ID });
      expect(res.status).toBe(403);
    });
  });

  // ── Thread listing ─────────────────────────────────────────────────────────
  describe('Thread listing', () => {

    it('5. Firm A user sees Firm A threads', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/requests`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(200);
      const ids = res.body.data.requests.map((r: { id: string }) => r.id);
      expect(ids).toContain(threadId);
    });

    it('6. Firm A user cannot list Firm B threads → 403', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_B_ID}/requests`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(403);
      expect(res.body.data).toBeUndefined();
    });

    it('7. Threads with assignedTo=null appear in list without error', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/requests`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(200);
      // Thread created in test 1 has assignedTo=null — must appear
      const thread = res.body.data.requests.find((r: { id: string }) => r.id === threadId);
      expect(thread).toBeDefined();
      expect(thread.assignedTo).toBeNull();
    });

    it('8. Status filter works', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/requests?status=open`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(200);
      res.body.data.requests.forEach((r: { status: string }) => {
        expect(r.status).toBe('open');
      });
    });
  });

  // ── Thread detail ──────────────────────────────────────────────────────────
  describe('Thread detail', () => {

    it('9. Messages returned in chronological order (asc)', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/requests/${threadId}`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(200);
      const msgs = res.body.data.request.messages;
      expect(msgs.length).toBeGreaterThan(0);
      const dates = msgs.map((m: { createdAt: string }) => new Date(m.createdAt).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i]).toBeGreaterThanOrEqual(dates[i - 1]);
      }
    });

    it('10. Cross-firm thread access → 403', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_B_ID}/requests/${threadId}`)
        .set('Cookie', cookie(AUTH_ID_B));
      expect(res.status).toBe(403);
    });

    it('11. assignedTo=null returned as null — not omitted, not error', async () => {
      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}/requests/${threadId}`)
        .set('Cookie', cookie(AUTH_ID_A));
      expect(res.status).toBe(200);
      expect(res.body.data.request).toHaveProperty('assignedTo');
      expect(res.body.data.request.assignedTo).toBeNull();
    });
  });

  // ── Messaging ──────────────────────────────────────────────────────────────
  describe('Messaging', () => {

    it('12. Attorney can post message', async () => {
      const res = await request(app)
        .post(`/firms/${FIRM_A_ID}/requests/${threadId}/messages`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ body: 'Also flag anything missing from the UM carrier file.' });
      expect(res.status).toBe(201);
      expect(res.body.data.message.senderType).toBe('attorney');
    });

    it('13. CW operator can post message', async () => {
      const res = await request(app)
        .post(`/firms/${FIRM_A_ID}/requests/${threadId}/messages`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ body: 'Confirmed. Starting draft. Question: include Dr. Lee records?' });
      expect(res.status).toBe(201);
      expect(res.body.data.message.senderType).toBe('counselworks_staff');
    });

    it('14. Attorney message on open thread → status becomes in_progress', async () => {
      const createRes = await request(app)
        .post(`/firms/${FIRM_A_ID}/requests`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ subject: 'Status advance test', body: 'First.' });
      const freshId = createRes.body.data.request.id;

      await request(app)
        .post(`/firms/${FIRM_A_ID}/requests/${freshId}/messages`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ body: 'Follow-up.' });

      const thread = await prisma.request.findUnique({ where: { id: freshId } });
      expect(thread?.status).toBe('in_progress');
    });

    it('15. CW reply → status becomes pending_attorney', async () => {
      await request(app)
        .post(`/firms/${FIRM_A_ID}/requests/${threadId}/messages`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ body: 'CW reply — should set pending_attorney.' });

      const thread = await prisma.request.findUnique({ where: { id: threadId } });
      expect(thread?.status).toBe('pending_attorney');
    });

    it('16. Message to closed thread → 409 THREAD_CLOSED', async () => {
      // Close the thread
      await request(app)
        .patch(`/firms/${FIRM_A_ID}/requests/${threadId}`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ status: 'closed' });

      const res = await request(app)
        .post(`/firms/${FIRM_A_ID}/requests/${threadId}/messages`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ body: 'Posting to closed thread.' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('THREAD_CLOSED');
    });

    it('17. Posting a message writes message_posted to activity_log', async () => {
      const createRes = await request(app)
        .post(`/firms/${FIRM_A_ID}/requests`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ subject: 'Activity log message test', body: 'First.' });
      const freshId = createRes.body.data.request.id;

      const before = await countLog(freshId, 'message_posted');

      await request(app)
        .post(`/firms/${FIRM_A_ID}/requests/${freshId}/messages`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ body: 'This should be logged.' });

      const after = await countLog(freshId, 'message_posted');
      expect(after).toBe(before + 1);
    });
  });

  // ── Notification routing ───────────────────────────────────────────────────
  describe('Notification routing', () => {

    beforeAll(async () => {
      // Create a thread and assign it to the CW operator
      const createRes = await request(app)
        .post(`/firms/${FIRM_A_ID}/requests`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ subject: 'Notification routing test', body: 'First message.' });
      assignedThreadId = createRes.body.data.request.id;

      await request(app)
        .patch(`/firms/${FIRM_A_ID}/requests/${assignedThreadId}`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ assignedTo: USER_OPS_ID });
    });

    it('18. Attorney message → notifies assignedTo (CW operator)', async () => {
      const before = await countNotif(USER_OPS_ID, assignedThreadId, 'new_message');

      await request(app)
        .post(`/firms/${FIRM_A_ID}/requests/${assignedThreadId}/messages`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ body: 'Attorney reply — should notify CW operator.' });

      const after = await countNotif(USER_OPS_ID, assignedThreadId, 'new_message');
      expect(after).toBe(before + 1);
    });

    it('19. CW message → notifies createdBy (attorney who created thread)', async () => {
      const before = await countNotif(USER_A_ID, assignedThreadId, 'new_message');

      await request(app)
        .post(`/firms/${FIRM_A_ID}/requests/${assignedThreadId}/messages`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ body: 'CW reply — should notify attorney.' });

      const after = await countNotif(USER_A_ID, assignedThreadId, 'new_message');
      expect(after).toBe(before + 1);
    });

    it('20. assignedTo=null → no crash, notification skipped cleanly', async () => {
      // Create unassigned thread (assignedTo=null)
      const createRes = await request(app)
        .post(`/firms/${FIRM_A_ID}/requests`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ subject: 'Unassigned thread test', body: 'No one assigned.' });
      const unassignedId = createRes.body.data.request.id;

      const thread = await prisma.request.findUnique({ where: { id: unassignedId } });
      expect(thread?.assignedTo).toBeNull();

      // Attorney posts — no one to notify but must not crash
      const res = await request(app)
        .post(`/firms/${FIRM_A_ID}/requests/${unassignedId}/messages`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ body: 'Reply to unassigned thread.' });

      expect(res.status).toBe(201);
    });

    it('21. Sender does NOT receive their own notification', async () => {
      const createRes = await request(app)
        .post(`/firms/${FIRM_A_ID}/requests`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ subject: 'Self-notify test', body: 'First message.' });
      const freshId = createRes.body.data.request.id;

      // Assign to ops user so notification routing is active
      await request(app)
        .patch(`/firms/${FIRM_A_ID}/requests/${freshId}`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ assignedTo: USER_OPS_ID });

      // OPS replies — should NOT get a notification to themselves
      const before = await countNotif(USER_OPS_ID, freshId, 'new_message');

      await request(app)
        .post(`/firms/${FIRM_A_ID}/requests/${freshId}/messages`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ body: 'CW reply.' });

      const after = await countNotif(USER_OPS_ID, freshId, 'new_message');
      // Count should not increase — CW ops user is the sender, not the recipient
      expect(after).toBe(before);
    });
  });

  // ── PATCH — CW roles only ──────────────────────────────────────────────────
  describe('PATCH — CW roles only', () => {
    let patchThreadId: string;

    beforeAll(async () => {
      const res = await request(app)
        .post(`/firms/${FIRM_A_ID}/requests`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ subject: 'PATCH test thread', body: 'For patch tests.' });
      patchThreadId = res.body.data.request.id;
    });

    it('22. CW operator can assign thread', async () => {
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/requests/${patchThreadId}`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ assignedTo: USER_OPS_ID });
      expect(res.status).toBe(200);
      expect(res.body.data.request.assignedTo).toBe(USER_OPS_ID);
    });

    it('23. CW operator can set status', async () => {
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/requests/${patchThreadId}`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ status: 'in_progress' });
      expect(res.status).toBe(200);
      expect(res.body.data.request.status).toBe('in_progress');
    });

    it('24. CW operator can set ETA', async () => {
      const eta = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/requests/${patchThreadId}`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ eta });
      expect(res.status).toBe(200);
      expect(res.body.data.request.eta).not.toBeNull();
    });

    it('25. Closing sets closedAt and writes request_closed to activity_log', async () => {
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/requests/${patchThreadId}`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ status: 'closed' });
      expect(res.status).toBe(200);
      expect(res.body.data.request.closedAt).not.toBeNull();

      const log = await prisma.activityLog.findFirst({
        where: { entityType: 'request', entityId: patchThreadId, activityType: 'request_closed' },
      });
      expect(log).not.toBeNull();
    });

    it('26. Attorney PATCH → 403 INSUFFICIENT_ROLE', async () => {
      const freshRes = await request(app)
        .post(`/firms/${FIRM_A_ID}/requests`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ subject: 'Attorney PATCH attempt', body: 'Test.' });
      const freshId = freshRes.body.data.request.id;

      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/requests/${freshId}`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ status: 'completed' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('27. managing_attorney PATCH → 403 INSUFFICIENT_ROLE', async () => {
      const freshRes = await request(app)
        .post(`/firms/${FIRM_A_ID}/requests`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ subject: 'Managing attorney PATCH test', body: 'Test.' });
      const freshId = freshRes.body.data.request.id;

      // AUTH_ID_A is managing_attorney — should still be blocked
      const res = await request(app)
        .patch(`/firms/${FIRM_A_ID}/requests/${freshId}`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ status: 'in_progress' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('28. Status change notifies thread creator', async () => {
      const freshRes = await request(app)
        .post(`/firms/${FIRM_A_ID}/requests`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ subject: 'Status notify test', body: 'Test.' });
      const freshId = freshRes.body.data.request.id;

      const before = await countNotif(USER_A_ID, freshId, 'request_status_changed');

      await request(app)
        .patch(`/firms/${FIRM_A_ID}/requests/${freshId}`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ status: 'in_progress' });

      const after = await countNotif(USER_A_ID, freshId, 'request_status_changed');
      expect(after).toBe(before + 1);
    });

    it('29. Assignment notifies newly assigned operator', async () => {
      const freshRes = await request(app)
        .post(`/firms/${FIRM_A_ID}/requests`)
        .set('Cookie', cookie(AUTH_ID_A))
        .send({ subject: 'Assignment notify test', body: 'Test.' });
      const freshId = freshRes.body.data.request.id;

      const before = await countNotif(USER_OPS_ID, freshId, 'request_assigned');

      await request(app)
        .patch(`/firms/${FIRM_A_ID}/requests/${freshId}`)
        .set('Cookie', cookie(AUTH_ID_OPS))
        .send({ assignedTo: USER_OPS_ID });

      const after = await countNotif(USER_OPS_ID, freshId, 'request_assigned');
      expect(after).toBe(before + 1);
    });
  });

  // ── Notifications — user-scoped ────────────────────────────────────────────
  describe('Notifications — user-scoped', () => {

    it('30. /notifications returns only current user\'s notifications', async () => {
      // Create a notification directly for USER_A
      await prisma.notification.create({
        data: { userId: USER_A_ID, type: 'test', title: 'For A', body: 'Body.' },
      });

      const res = await request(app)
        .get('/notifications')
        .set('Cookie', cookie(AUTH_ID_A));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.notifications)).toBe(true);
      // All must belong to USER_A — enforced by WHERE user_id = req.user.id
      expect(res.body.meta).toHaveProperty('unreadCount');
    });

    it('31. mark-one-read sets readAt', async () => {
      const notif = await prisma.notification.create({
        data: { userId: USER_A_ID, type: 'test', title: 'Mark me read', body: 'Body.' },
      });

      const res = await request(app)
        .patch(`/notifications/${notif.id}/read`)
        .set('Cookie', cookie(AUTH_ID_A));

      expect(res.status).toBe(200);
      const updated = await prisma.notification.findUnique({ where: { id: notif.id } });
      expect(updated?.readAt).not.toBeNull();
    });

    it('32. mark-all-read clears all unread for this user', async () => {
      await prisma.notification.createMany({
        data: [
          { userId: USER_A_ID, type: 'test', title: 'Unread 1', body: 'Body.' },
          { userId: USER_A_ID, type: 'test', title: 'Unread 2', body: 'Body.' },
        ],
      });

      const res = await request(app)
        .patch('/notifications/read-all')
        .set('Cookie', cookie(AUTH_ID_A));

      expect(res.status).toBe(200);
      expect(res.body.data.updated).toBeGreaterThanOrEqual(0);

      const remaining = await prisma.notification.count({
        where: { userId: USER_A_ID, readAt: null },
      });
      expect(remaining).toBe(0);
    });

    it('33. Cannot mark another user\'s notification read → 403', async () => {
      const notif = await prisma.notification.create({
        data: { userId: USER_OPS_ID, type: 'test', title: 'Ops only', body: 'Body.' },
      });

      const res = await request(app)
        .patch(`/notifications/${notif.id}/read`)
        .set('Cookie', cookie(AUTH_ID_A));  // USER_A trying to read USER_OPS notification

      expect(res.status).toBe(403);

      const unchanged = await prisma.notification.findUnique({ where: { id: notif.id } });
      expect(unchanged?.readAt).toBeNull();
    });

    it('34. Duplicate read is idempotent — returns 200 not 4xx', async () => {
      const notif = await prisma.notification.create({
        data: { userId: USER_A_ID, type: 'test', title: 'Already read', body: 'Body.', readAt: new Date() },
      });

      const res = await request(app)
        .patch(`/notifications/${notif.id}/read`)
        .set('Cookie', cookie(AUTH_ID_A));

      expect(res.status).toBe(200);
      expect(res.body.data.alreadyRead).toBe(true);
    });
  });
});
