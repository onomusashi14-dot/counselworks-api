/**
 * tests/middleware/middleware.test.ts
 * Unit tests for all three middleware functions.
 * Prisma is fully mocked — no database required.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

jest.mock('../../src/config/prisma', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    firm: {
      findUnique: jest.fn(),
    },
    firmMembership: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
  },
}));

import { prisma } from '../../src/config/prisma';
import { authenticate } from '../../src/middleware/authenticate';
import { requireFirmAccess } from '../../src/middleware/requireFirmAccess';
import { requireRole } from '../../src/middleware/requireRole';

const TEST_SECRET = 'test-secret-for-unit-tests';
process.env.SUPABASE_JWT_SECRET = TEST_SECRET;

function makeToken(sub: string, secret = TEST_SECRET): string {
  return jwt.sign({ sub, email: 'test@test.com' }, secret, { expiresIn: '1h' });
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return { cookies: {}, params: {}, body: {}, headers: {}, ip: '127.0.0.1', ...overrides } as unknown as Request;
}

function mockRes() {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, status, json };
}

const next = jest.fn() as NextFunction;

beforeEach(() => jest.clearAllMocks());

// ─── AUTHENTICATE ─────────────────────────────────────────────────────────────
describe('authenticate', () => {
  const mockUser = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    authId: 'auth-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    email: 'test@firm.com',
    fullName: 'Test Attorney',
    archivedAt: null,
  };

  it('passes with valid cookie and existing user', async () => {
    const token = makeToken(mockUser.authId);
    const req = mockReq({ cookies: { cw_session: token } });
    const { res } = mockRes();
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(mockUser);

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user?.id).toBe(mockUser.id);
    expect(req.user?.authId).toBe(mockUser.authId);
  });

  it('returns 401 when no cookie present', async () => {
    const req = mockReq({ cookies: {} });
    const { res, status } = mockRes();

    await authenticate(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for malformed token', async () => {
    const req = mockReq({ cookies: { cw_session: 'not.a.real.token' } });
    const { res, status } = mockRes();

    await authenticate(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for token signed with wrong secret', async () => {
    const token = makeToken(mockUser.authId, 'wrong-secret');
    const req = mockReq({ cookies: { cw_session: token } });
    const { res, status } = mockRes();

    await authenticate(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when user not found in DB', async () => {
    const token = makeToken(mockUser.authId);
    const req = mockReq({ cookies: { cw_session: token } });
    const { res, status } = mockRes();
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);

    await authenticate(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for archived user', async () => {
    const token = makeToken(mockUser.authId);
    const req = mockReq({ cookies: { cw_session: token } });
    const { res, status } = mockRes();
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ ...mockUser, archivedAt: new Date() });

    await authenticate(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── REQUIRE FIRM ACCESS ──────────────────────────────────────────────────────
describe('requireFirmAccess', () => {
  const mockFirm = { id: '11111111-1111-1111-1111-111111111111', archivedAt: null };
  const mockMembership = {
    id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    role: 'managing_attorney',
    archivedAt: null,
  };
  const mockUser = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    authId: 'auth-aaaa',
    email: 'a@test.com',
    fullName: 'Test',
  };

  it('passes when user has active membership in requested firm', async () => {
    const req = mockReq({ user: mockUser, params: { firmId: mockFirm.id } });
    const { res } = mockRes();
    (prisma.firm.findUnique as jest.Mock).mockResolvedValueOnce(mockFirm);
    (prisma.firmMembership.findUnique as jest.Mock).mockResolvedValueOnce(mockMembership);

    await requireFirmAccess()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.firmContext?.firmId).toBe(mockFirm.id);
    expect(req.firmContext?.role).toBe('managing_attorney');
  });

  it('returns 403 when user has NO membership in requested firm', async () => {
    const req = mockReq({ user: mockUser, params: { firmId: '22222222-2222-2222-2222-222222222222' } });
    const { res, status, json } = mockRes();
    (prisma.firm.findUnique as jest.Mock).mockResolvedValueOnce({ id: '22222222-2222-2222-2222-222222222222', archivedAt: null });
    (prisma.firmMembership.findUnique as jest.Mock).mockResolvedValueOnce(null);
    (prisma.firmMembership.findFirst as jest.Mock).mockResolvedValueOnce(null);

    await requireFirmAccess()(req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(json.mock.calls[0][0].error.code).toBe('FORBIDDEN');
    expect(json.mock.calls[0][0].data).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 for nonexistent firm — never 404', async () => {
    const req = mockReq({ user: mockUser, params: { firmId: '00000000-0000-0000-0000-000000000000' } });
    const { res, status } = mockRes();
    (prisma.firm.findUnique as jest.Mock).mockResolvedValueOnce(null);

    await requireFirmAccess()(req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when req.user is missing', async () => {
    const req = mockReq({ params: { firmId: mockFirm.id } });
    const { res, status } = mockRes();

    await requireFirmAccess()(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 for archived membership', async () => {
    const req = mockReq({ user: mockUser, params: { firmId: mockFirm.id } });
    const { res, status } = mockRes();
    (prisma.firm.findUnique as jest.Mock).mockResolvedValueOnce(mockFirm);
    (prisma.firmMembership.findUnique as jest.Mock).mockResolvedValueOnce({ ...mockMembership, archivedAt: new Date() });

    await requireFirmAccess()(req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('cw_admin with no firm membership can still access the firm (Option A)', async () => {
    const cwAdminUser = { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', authId: 'auth-cw', email: 'cw@test.com', fullName: 'CW Admin' };
    const req = mockReq({ user: cwAdminUser, params: { firmId: mockFirm.id } });
    const { res } = mockRes();
    (prisma.firm.findUnique as jest.Mock).mockResolvedValueOnce(mockFirm);
    // No firm-specific membership
    (prisma.firmMembership.findUnique as jest.Mock).mockResolvedValueOnce(null);
    // But has a global cw_admin membership somewhere
    (prisma.firmMembership.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      role: 'counselworks_admin',
    });

    await requireFirmAccess()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.firmContext?.role).toBe('counselworks_admin');
    expect(req.firmContext?.membershipId).toBeNull();
  });
});

// ─── REQUIRE ROLE ─────────────────────────────────────────────────────────────
describe('requireRole', () => {
  it('passes when user has an allowed role', () => {
    const req = mockReq({ firmContext: { firmId: '11111111-1111-1111-1111-111111111111', role: 'managing_attorney', membershipId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' } });
    const { res } = mockRes();

    requireRole('managing_attorney', 'counselworks_admin')(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when user has insufficient role', () => {
    const req = mockReq({ firmContext: { firmId: '11111111-1111-1111-1111-111111111111', role: 'case_manager', membershipId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' } });
    const { res, status, json } = mockRes();

    requireRole('managing_attorney', 'counselworks_admin')(req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(json.mock.calls[0][0].error.code).toBe('INSUFFICIENT_ROLE');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when firmContext is missing', () => {
    const req = mockReq({});
    const { res, status } = mockRes();

    requireRole('managing_attorney')(req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
