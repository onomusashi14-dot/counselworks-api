/**
 * src/modules/auth/auth.router.ts
 *
 * Auth endpoints — Phase 6
 *
 * Security model:
 *   - Access token: short-lived JWT (1h) in httpOnly session cookie
 *   - Refresh token: long-lived (7d) random token, stored as bcrypt hash in DB
 *   - Raw refresh token is NEVER stored — only its hash
 *   - Refresh rotates: old token deleted, new token issued
 *   - Logout deletes the refresh token row — invalidates the session server-side
 *   - Multiple sessions: each device gets its own refresh_tokens row
 *   - /auth/me reads ONLY from the session cookie — no header fallback
 *
 * Routes:
 *   POST /auth/login       Email + password → set session + refresh cookies
 *   POST /auth/refresh     Rotate refresh token → new session cookie
 *   POST /auth/logout      Delete refresh token row → clear cookies
 *   GET  /auth/me          Current user + firm memberships (cookie only)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../../config/prisma';
import { authenticate } from '../../middleware/authenticate';
import {
  SESSION_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  REFRESH_COOKIE_OPTIONS,
} from '../../config/cookies';

export const authRouter = Router();

const JWT_SECRET  = process.env.SUPABASE_JWT_SECRET ?? '';
const BCRYPT_ROUNDS = 12;
const REFRESH_TOKEN_BYTES = 48; // 384 bits — sufficient entropy
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ACCESS_TTL_S  = 60 * 60;                   // 1 hour

// ─── SUPABASE AUTH HELPER ─────────────────────────────────────────────────────
// Validates email + password against Supabase Auth.
// Returns the Supabase user on success, throws on failure.
async function verifySupabaseCredentials(
  email: string,
  password: string
): Promise<{ id: string; email: string }> {
  const supabaseUrl  = process.env.SUPABASE_URL ?? '';
  const supabaseKey  = process.env.SUPABASE_ANON_KEY ?? '';

  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
    },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new Error('Invalid credentials');
  }

  const data = await response.json() as { user?: { id: string; email: string } };
  if (!data.user) throw new Error('Invalid credentials');
  return data.user;
}

// ─── TOKEN HELPERS ────────────────────────────────────────────────────────────
function generateAccessToken(authId: string, email: string): string {
  return jwt.sign(
    { sub: authId, email },
    JWT_SECRET,
    { expiresIn: ACCESS_TTL_S }
  );
}

function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
}

async function storeRefreshToken(userId: string, rawToken: string): Promise<void> {
  const hash      = await bcrypt.hash(rawToken, BCRYPT_ROUNDS);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

  await prisma.refreshToken.create({
    data: { userId, tokenHash: hash, expiresAt },
  });
}

// ─── SCHEMAS ──────────────────────────────────────────────────────────────────
const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
}).strict();

// ─── POST /auth/login ─────────────────────────────────────────────────────────
authRouter.post('/login', async (req: Request, res: Response): Promise<void> => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Email and password are required.' },
    });
    return;
  }

  const { email, password } = parsed.data;

  // Verify credentials with Supabase Auth
  let supabaseUser: { id: string; email: string };
  try {
    supabaseUser = await verifySupabaseCredentials(email, password);
  } catch {
    // Intentionally vague — never reveal whether email exists
    res.status(401).json({
      ok: false,
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
    });
    return;
  }

  // Look up user in our database by Supabase auth_id
  const user = await prisma.user.findUnique({
    where: { authId: supabaseUser.id },
    select: {
      id: true, authId: true, email: true, fullName: true,
      archivedAt: true,
      memberships: {
        where: { archivedAt: null },
        select: { firmId: true, role: true, isPrimary: true },
      },
    },
  });

  if (!user || user.archivedAt !== null) {
    res.status(401).json({
      ok: false,
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
    });
    return;
  }

  // Issue tokens
  const accessToken  = generateAccessToken(user.authId, user.email);
  const refreshToken = generateRefreshToken();

  // Store hashed refresh token in DB (raw token never persisted)
  await storeRefreshToken(user.id, refreshToken);

  // Update last active
  prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } })
    .catch(() => {});

  // Set cookies (same-domain fallback)
  res.cookie(SESSION_COOKIE_NAME, accessToken, SESSION_COOKIE_OPTIONS);
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);

  // Return tokens in body for cross-domain Bearer auth
  res.status(200).json({
    ok: true,
    data: {
      user: {
        id:       user.id,
        email:    user.email,
        fullName: user.fullName,
        memberships: user.memberships,
      },
      accessToken,
      refreshToken,
    },
  });
});

// ─── POST /auth/refresh ───────────────────────────────────────────────────────
authRouter.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  // Accept refresh token from body (cross-domain) or cookie (same-domain fallback)
  const rawToken = req.body?.refreshToken ?? req.cookies?.[REFRESH_COOKIE_NAME];

  if (!rawToken) {
    res.status(401).json({
      ok: false,
      error: { code: 'UNAUTHENTICATED', message: 'No refresh token provided.' },
    });
    return;
  }

  // Find all non-expired refresh tokens for this request
  // We must check all of them because we don't store a token ID in the cookie
  const now = new Date();
  const candidates = await prisma.refreshToken.findMany({
    where: { expiresAt: { gt: now } },
    select: { id: true, userId: true, tokenHash: true },
    orderBy: { createdAt: 'desc' },
    take: 20, // reasonable upper bound — prevents full-table scan
  });

  // Find the matching token by comparing bcrypt hashes
  let matched: { id: string; userId: string } | null = null;
  for (const candidate of candidates) {
    const valid = await bcrypt.compare(rawToken, candidate.tokenHash);
    if (valid) {
      matched = { id: candidate.id, userId: candidate.userId };
      break;
    }
  }

  if (!matched) {
    // Token not found or expired — clear cookies and reject
    res.clearCookie(SESSION_COOKIE_NAME);
    res.clearCookie(REFRESH_COOKIE_NAME);
    res.status(401).json({
      ok: false,
      error: { code: 'TOKEN_INVALID', message: 'Refresh token is invalid or expired. Please log in again.' },
    });
    return;
  }

  // Load user
  const user = await prisma.user.findUnique({
    where: { id: matched.userId },
    select: { id: true, authId: true, email: true, fullName: true, archivedAt: true },
  });

  if (!user || user.archivedAt !== null) {
    await prisma.refreshToken.delete({ where: { id: matched.id } });
    res.clearCookie(SESSION_COOKIE_NAME);
    res.clearCookie(REFRESH_COOKIE_NAME);
    res.status(401).json({
      ok: false,
      error: { code: 'USER_NOT_FOUND', message: 'User not found. Please log in again.' },
    });
    return;
  }

  // ── ROTATE: delete old token, issue new one ───────────────────────────────
  const newRefreshToken = generateRefreshToken();
  const newAccessToken  = generateAccessToken(user.authId, user.email);

  await prisma.$transaction([
    // Delete the used token — prevents replay attacks
    prisma.refreshToken.delete({ where: { id: matched.id } }),
    // Store new hashed token
    prisma.refreshToken.create({
      data: {
        userId:    user.id,
        tokenHash: '', // placeholder — replaced below
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    }),
  ]);

  // Hash and update in a second step (bcrypt.hash is async, can't run in transaction)
  const newHash = await bcrypt.hash(newRefreshToken, BCRYPT_ROUNDS);
  await prisma.refreshToken.updateMany({
    where: { userId: user.id, tokenHash: '' },
    data:  { tokenHash: newHash },
  });

  res.cookie(SESSION_COOKIE_NAME, newAccessToken,  SESSION_COOKIE_OPTIONS);
  res.cookie(REFRESH_COOKIE_NAME, newRefreshToken, REFRESH_COOKIE_OPTIONS);

  // Return tokens in body for cross-domain Bearer auth
  res.status(200).json({
    ok: true,
    data: {
      message: 'Session refreshed.',
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    },
  });
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────
// Deletes the matching refresh token row server-side.
// Cookie clearing alone is not sufficient — the token must be revoked in DB.
authRouter.post('/logout', async (req: Request, res: Response): Promise<void> => {
  const rawToken = req.body?.refreshToken ?? req.cookies?.[REFRESH_COOKIE_NAME];

  if (rawToken) {
    // Find and delete the matching refresh token
    const now = new Date();
    const candidates = await prisma.refreshToken.findMany({
      where: { expiresAt: { gt: now } },
      select: { id: true, tokenHash: true },
      take: 20,
    });

    for (const candidate of candidates) {
      const valid = await bcrypt.compare(rawToken, candidate.tokenHash);
      if (valid) {
        await prisma.refreshToken.delete({ where: { id: candidate.id } });
        break;
      }
    }
  }

  // Clear cookies regardless of whether token was found
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/auth/refresh' });

  res.status(200).json({ ok: true, data: { message: 'Logged out.' } });
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────
// Reads ONLY from the session cookie — no Authorization header fallback.
// authenticate middleware enforces this: it reads req.cookies[SESSION_COOKIE_NAME].
authRouter.get('/me', authenticate, async (req: Request, res: Response): Promise<void> => {
  // req.user is set by authenticate middleware (cookie-only)
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      id: true, email: true, fullName: true, createdAt: true,
      memberships: {
        where: { archivedAt: null },
        select: {
          firmId: true, role: true, isPrimary: true,
          firm: { select: { id: true, name: true, slug: true, status: true } },
        },
      },
    },
  });

  if (!user) {
    res.status(401).json({
      ok: false,
      error: { code: 'USER_NOT_FOUND', message: 'User not found.' },
    });
    return;
  }

  res.status(200).json({ ok: true, data: { user } });
});
