/**
 * authenticate middleware
 * Reads JWT from Authorization: Bearer header first, falls back to httpOnly cookie.
 * Verifies it, loads user from DB.
 * Attaches req.user — all subsequent handlers can rely on it.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/prisma';
import { SESSION_COOKIE_NAME } from '../config/cookies';
import { AuthenticatedUser } from '../types';

interface SupabaseJwtPayload {
  sub: string;
  email: string;
  iat: number;
  exp: number;
}

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // ─── DEV-ONLY AUTO-LOGIN ────────────────────────────────────────────────────
  // When DEV_AUTO_USER_ID is set AND NODE_ENV !== 'production', skip JWT
  // verification and attach the specified user to the request. This exists
  // solely so the frontend dev server can talk to the API without a real
  // Supabase session. It is inert in production.
  if (
    process.env.DEV_AUTO_USER_ID &&
    process.env.NODE_ENV !== 'production'
  ) {
    const devUser = await prisma.user.findUnique({
      where: { id: process.env.DEV_AUTO_USER_ID },
      select: { id: true, authId: true, email: true, fullName: true, archivedAt: true },
    });
    if (devUser && devUser.archivedAt === null) {
      req.user = {
        id: devUser.id,
        authId: devUser.authId,
        email: devUser.email,
        fullName: devUser.fullName,
      } satisfies AuthenticatedUser;
      prisma.user
        .update({ where: { id: devUser.id }, data: { lastActiveAt: new Date() } })
        .catch(() => {});
      return next();
    }
  }

  // 1. Try Authorization: Bearer header first (cross-domain friendly)
  // 2. Fall back to httpOnly cookie (same-domain / legacy)
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  if (!token) {
    token = req.cookies?.[SESSION_COOKIE_NAME];
  }

  if (!token) {
    res.status(401).json({
      ok: false,
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
    });
    return;
  }

  let payload: SupabaseJwtPayload;

  try {
    payload = jwt.verify(
      token,
      process.env.SUPABASE_JWT_SECRET ?? ''
    ) as SupabaseJwtPayload;
  } catch {
    res.status(401).json({
      ok: false,
      error: { code: 'TOKEN_INVALID', message: 'Session expired or invalid. Please log in again.' },
    });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { authId: payload.sub },
    select: { id: true, authId: true, email: true, fullName: true, archivedAt: true },
  });

  if (!user || user.archivedAt !== null) {
    res.status(401).json({
      ok: false,
      error: { code: 'USER_NOT_FOUND', message: 'User account not found or deactivated.' },
    });
    return;
  }

  req.user = {
    id: user.id,
    authId: user.authId,
    email: user.email,
    fullName: user.fullName,
  } satisfies AuthenticatedUser;

  // Fire-and-forget — not critical path
  prisma.user
    .update({ where: { id: user.id }, data: { lastActiveAt: new Date() } })
    .catch(() => {});

  next();
}
