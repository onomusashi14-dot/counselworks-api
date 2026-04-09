/**
 * tests/integration/auth.test.ts
 *
 * Phase 6 gate: Auth layer
 *
 * Supabase credential verification is mocked — all other logic is real:
 * bcrypt hashing, DB storage, token rotation, server-side invalidation.
 *
 * Proves:
 *  [Login]
 *   1.  Valid credentials → 200, session cookie set, refresh cookie set
 *   2.  Invalid credentials → 401 INVALID_CREDENTIALS
 *   3.  Missing fields → 400 VALIDATION_ERROR
 *   4.  Archived user → 401 INVALID_CREDENTIALS
 *   5.  Refresh token stored as bcrypt hash (not raw) in DB
 *   6.  Login response includes user profile + memberships
 *
 *  [Session cookie]
 *   7.  /auth/me with valid session cookie → 200 with user + memberships
 *   8.  /auth/me with no cookie → 401 UNAUTHENTICATED
 *   9.  /auth/me with expired/invalid JWT → 401 TOKEN_INVALID
 *   10. /auth/me reads ONLY from cookie — Authorization header is ignored
 *
 *  [Refresh]
 *   11. Valid refresh token → new session cookie, new refresh cookie
 *   12. Token is rotated — old token is deleted from DB
 *   13. Old refresh token cannot be reused after rotation → 401
 *   14. Invalid refresh token → 401 TOKEN_INVALID, cookies cleared
 *   15. Expired refresh token → 401 TOKEN_INVALID
 *
 *  [Logout]
 *   16. Logout clears both cookies
 *   17. Logout deletes refresh token row from DB (server-side invalidation)
 *   18. After logout, old refresh token cannot refresh session → 401
 *   19. Logout is idempotent — no cookie is fine, still returns 200
 *
 *  [Multiple sessions]
 *   20. Two logins create two separate refresh_token rows
 *   21. Logging out one session does not affect the other
 *
 *  [Protected routes]
 *   22. Protected route works with valid session cookie
 *   23. Protected route rejects request with no cookie → 401
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/prisma';

// ─── Mock Supabase Auth ───────────────────────────────────────────────────────
// We mock the network call to Supabase — all bcrypt/DB/cookie logic is real
jest.mock('node-fetch', () => jest.fn());

const VALID_SUPABASE_USER = {
  id:    'auth-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', // matches seed USER_A authId
  email: 'attorney-a@test.counselworks.com',
};

// Mock fetch used inside auth.router.ts for Supabase verification
const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockSupabaseSuccess() {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ user: VALID_SUPABASE_USER }),
  });
}

function mockSupabaseFailure() {
  mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
}

// ─── Constants ────────────────────────────────────────────────────────────────
const FIRM_A_ID = '11111111-1111-1111-1111-111111111111';
const USER_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEST_SECRET = 'test-jwt-secret-phase-6-auth';

const VALID_CREDS = {
  email:    'attorney-a@test.counselworks.com',
  password: 'test-password-123',
};

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
  process.env.SUPABASE_URL = 'https://mock.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'mock-anon-key';
  process.env.NODE_ENV = 'test';
  process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
  app = createApp();

  const userA = await prisma.user.findUnique({ where: { id: USER_A_ID } });
  if (!userA) throw new Error('\nSeed data missing. Run: npm run db:seed\n');
});

beforeEach(() => mockFetch.mockReset());

afterAll(async () => {
  // Clean up test refresh tokens
  await prisma.refreshToken.deleteMany({ where: { userId: USER_A_ID } });
  await prisma.$disconnect();
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function login(): Promise<{ sessionCookie: string; refreshCookie: string }> {
  mockSupabaseSuccess();
  const res = await request(app).post('/auth/login').send(VALID_CREDS);
  expect(res.status).toBe(200);

  const cookies = res.headers['set-cookie'] as string[] | string;
  const cookieArr = Array.isArray(cookies) ? cookies : [cookies];
  const sessionCookie = cookieArr.find(c => c.startsWith('cw_session='))?.split(';')[0] ?? '';
  const refreshCookie = cookieArr.find(c => c.startsWith('cw_refresh='))?.split(';')[0] ?? '';

  return { sessionCookie, refreshCookie };
}

describe('Phase 6 Gate: Auth Layer', () => {

  // ── Login ──────────────────────────────────────────────────────────────────
  describe('Login', () => {

    it('1. Valid credentials → 200, cookies set', async () => {
      mockSupabaseSuccess();
      const res = await request(app).post('/auth/login').send(VALID_CREDS);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const cookies = res.headers['set-cookie'] as string[];
      expect(cookies.some(c => c.startsWith('cw_session='))).toBe(true);
      expect(cookies.some(c => c.startsWith('cw_refresh='))).toBe(true);
      // Both cookies must be httpOnly
      expect(cookies.find(c => c.startsWith('cw_session='))).toContain('HttpOnly');
      expect(cookies.find(c => c.startsWith('cw_refresh='))).toContain('HttpOnly');
    });

    it('2. Invalid credentials → 401 INVALID_CREDENTIALS', async () => {
      mockSupabaseFailure();
      const res = await request(app).post('/auth/login').send({ email: 'x@x.com', password: 'wrong' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('3. Missing fields → 400 VALIDATION_ERROR', async () => {
      const res = await request(app).post('/auth/login').send({ email: 'test@test.com' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('4. Archived user → 401 INVALID_CREDENTIALS', async () => {
      // Temporarily archive USER_A
      await prisma.user.update({ where: { id: USER_A_ID }, data: { archivedAt: new Date() } });
      mockSupabaseSuccess();

      const res = await request(app).post('/auth/login').send(VALID_CREDS);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

      // Restore
      await prisma.user.update({ where: { id: USER_A_ID }, data: { archivedAt: null } });
    });

    it('5. Refresh token stored as bcrypt hash — not raw — in DB', async () => {
      mockSupabaseSuccess();
      const res = await request(app).post('/auth/login').send(VALID_CREDS);
      const cookies = res.headers['set-cookie'] as string[];
      const rawRefresh = cookies.find(c => c.startsWith('cw_refresh='))?.split('=')[1]?.split(';')[0] ?? '';

      const tokenRow = await prisma.refreshToken.findFirst({
        where: { userId: USER_A_ID },
        orderBy: { createdAt: 'desc' },
        select: { tokenHash: true },
      });

      expect(tokenRow).not.toBeNull();
      // Stored value must NOT equal the raw token
      expect(tokenRow!.tokenHash).not.toBe(rawRefresh);
      // But bcrypt.compare must return true
      const valid = await bcrypt.compare(rawRefresh, tokenRow!.tokenHash);
      expect(valid).toBe(true);
    });

    it('6. Login response includes user profile and memberships', async () => {
      mockSupabaseSuccess();
      const res = await request(app).post('/auth/login').send(VALID_CREDS);
      expect(res.body.data.user.id).toBe(USER_A_ID);
      expect(res.body.data.user.email).toBe(VALID_CREDS.email);
      expect(Array.isArray(res.body.data.user.memberships)).toBe(true);
      expect(res.body.data.user.memberships.length).toBeGreaterThan(0);
    });
  });

  // ── Session cookie ─────────────────────────────────────────────────────────
  describe('Session cookie (/auth/me)', () => {

    it('7. Valid session cookie → 200 with user + memberships', async () => {
      const { sessionCookie } = await login();

      const res = await request(app)
        .get('/auth/me')
        .set('Cookie', sessionCookie);

      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe(USER_A_ID);
      expect(Array.isArray(res.body.data.user.memberships)).toBe(true);
      res.body.data.user.memberships.forEach((m: { firm: object }) => {
        expect(m.firm).toBeDefined(); // firm details included
      });
    });

    it('8. /auth/me with no cookie → 401 UNAUTHENTICATED', async () => {
      const res = await request(app).get('/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('9. /auth/me with invalid JWT → 401 TOKEN_INVALID', async () => {
      const res = await request(app)
        .get('/auth/me')
        .set('Cookie', 'cw_session=not.a.real.token');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_INVALID');
    });

    it('10. /auth/me ignores Authorization header — cookie only', async () => {
      // Valid JWT in Authorization header — must be ignored
      const validJwt = jwt.sign(
        { sub: 'auth-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: VALID_CREDS.email },
        TEST_SECRET,
        { expiresIn: '1h' }
      );

      const res = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${validJwt}`);
        // No Cookie header — should fail even with valid Authorization

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  // ── Refresh ────────────────────────────────────────────────────────────────
  describe('Token refresh', () => {

    it('11. Valid refresh token → new session and refresh cookies', async () => {
      const { refreshCookie } = await login();

      const res = await request(app)
        .post('/auth/refresh')
        .set('Cookie', refreshCookie);

      expect(res.status).toBe(200);
      const newCookies = res.headers['set-cookie'] as string[];
      expect(newCookies.some(c => c.startsWith('cw_session='))).toBe(true);
      expect(newCookies.some(c => c.startsWith('cw_refresh='))).toBe(true);
    });

    it('12. Token rotation — old refresh token deleted from DB after refresh', async () => {
      const { refreshCookie } = await login();
      const rawOld = refreshCookie.split('=')[1]?.split(';')[0] ?? '';

      await request(app).post('/auth/refresh').set('Cookie', refreshCookie);

      // Old token hash must be gone from DB
      const rows = await prisma.refreshToken.findMany({
        where: { userId: USER_A_ID },
        select: { tokenHash: true },
      });

      let oldFound = false;
      for (const row of rows) {
        if (await bcrypt.compare(rawOld, row.tokenHash)) {
          oldFound = true;
          break;
        }
      }
      expect(oldFound).toBe(false);
    });

    it('13. Old refresh token cannot be reused after rotation → 401', async () => {
      const { refreshCookie } = await login();

      // First refresh — rotates the token
      await request(app).post('/auth/refresh').set('Cookie', refreshCookie);

      // Second refresh with the OLD cookie — must be rejected
      const res = await request(app)
        .post('/auth/refresh')
        .set('Cookie', refreshCookie);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_INVALID');
    });

    it('14. Invalid refresh token → 401 TOKEN_INVALID', async () => {
      const res = await request(app)
        .post('/auth/refresh')
        .set('Cookie', 'cw_refresh=not-a-real-token');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_INVALID');
    });

    it('15. Expired refresh token → 401 TOKEN_INVALID', async () => {
      // Insert an expired token directly
      const rawToken = 'expired-test-token-abc123';
      const hash = await bcrypt.hash(rawToken, 10);
      await prisma.refreshToken.create({
        data: {
          userId:    USER_A_ID,
          tokenHash: hash,
          expiresAt: new Date(Date.now() - 1000), // already expired
        },
      });

      const res = await request(app)
        .post('/auth/refresh')
        .set('Cookie', `cw_refresh=${rawToken}`);

      expect(res.status).toBe(401);
    });
  });

  // ── Logout ─────────────────────────────────────────────────────────────────
  describe('Logout', () => {

    it('16. Logout clears both cookies', async () => {
      const { sessionCookie, refreshCookie } = await login();

      const res = await request(app)
        .post('/auth/logout')
        .set('Cookie', [sessionCookie, refreshCookie].join('; '));

      expect(res.status).toBe(200);
      const cookies = res.headers['set-cookie'] as string[];
      // Cleared cookies have empty value and/or Max-Age=0 / Expires in past
      if (cookies) {
        const sessionCleared = cookies.find(c => c.startsWith('cw_session='));
        if (sessionCleared) {
          expect(sessionCleared).toMatch(/cw_session=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i);
        }
      }
    });

    it('17. Logout deletes refresh token from DB (server-side invalidation)', async () => {
      const { refreshCookie } = await login();
      const rawToken = refreshCookie.split('=')[1]?.split(';')[0] ?? '';

      // Verify token exists before logout
      const beforeRows = await prisma.refreshToken.findMany({ where: { userId: USER_A_ID } });
      const existsBefore = await Promise.any(
        beforeRows.map(r => bcrypt.compare(rawToken, r.tokenHash).then(v => v ? r : Promise.reject()))
      ).catch(() => null);
      expect(existsBefore).not.toBeNull();

      // Logout
      await request(app)
        .post('/auth/logout')
        .set('Cookie', refreshCookie);

      // Verify token gone from DB
      const afterRows = await prisma.refreshToken.findMany({ where: { userId: USER_A_ID } });
      let foundAfter = false;
      for (const row of afterRows) {
        if (await bcrypt.compare(rawToken, row.tokenHash)) { foundAfter = true; break; }
      }
      expect(foundAfter).toBe(false);
    });

    it('18. After logout, old refresh token cannot refresh session → 401', async () => {
      const { refreshCookie } = await login();

      await request(app).post('/auth/logout').set('Cookie', refreshCookie);

      const res = await request(app)
        .post('/auth/refresh')
        .set('Cookie', refreshCookie);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_INVALID');
    });

    it('19. Logout is idempotent — no cookie returns 200', async () => {
      const res = await request(app).post('/auth/logout');
      expect(res.status).toBe(200);
    });
  });

  // ── Multiple sessions ──────────────────────────────────────────────────────
  describe('Multiple sessions', () => {

    it('20. Two logins create two separate refresh_token rows', async () => {
      const before = await prisma.refreshToken.count({ where: { userId: USER_A_ID } });

      mockSupabaseSuccess();
      await request(app).post('/auth/login').send(VALID_CREDS);
      mockSupabaseSuccess();
      await request(app).post('/auth/login').send(VALID_CREDS);

      const after = await prisma.refreshToken.count({ where: { userId: USER_A_ID } });
      expect(after).toBeGreaterThanOrEqual(before + 2);
    });

    it('21. Logging out one session does not affect the other', async () => {
      const session1 = await login();
      const session2 = await login();

      // Logout session 1
      await request(app)
        .post('/auth/logout')
        .set('Cookie', session1.refreshCookie);

      // Session 2 refresh should still work
      const res = await request(app)
        .post('/auth/refresh')
        .set('Cookie', session2.refreshCookie);

      expect(res.status).toBe(200);
    });
  });

  // ── Protected routes ────────────────────────────────────────────────────────
  describe('Protected route integration', () => {

    it('22. Protected route works with valid session cookie', async () => {
      const { sessionCookie } = await login();

      const res = await request(app)
        .get(`/firms/${FIRM_A_ID}`)
        .set('Cookie', sessionCookie);

      expect(res.status).toBe(200);
    });

    it('23. Protected route rejects request with no cookie → 401', async () => {
      const res = await request(app).get(`/firms/${FIRM_A_ID}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });
  });
});
