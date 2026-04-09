/**
 * requireFirmAccess middleware — THE TENANT ISOLATION GATE
 *
 * Policy (locked — Option A):
 *   counselworks_admin → bypasses firm membership check, can access any firm
 *   All other roles    → must have an active membership in the requested firm
 *
 * Always returns 403 (never 404) for inaccessible or nonexistent firms.
 * We never reveal whether another firm's data exists.
 *
 * MUST run after authenticate middleware.
 */

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';
import { CW_GLOBAL_ROLES, FirmRole } from '../types';

export function requireFirmAccess(firmIdParam = 'firmId') {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    if (!req.user) {
      res.status(401).json({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
      });
      return;
    }

    const firmId = req.params[firmIdParam];

    if (!firmId) {
      res.status(400).json({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'Firm ID is required.' },
      });
      return;
    }

    // Verify firm exists and is not archived
    const firm = await prisma.firm.findUnique({
      where: { id: firmId },
      select: { id: true, archivedAt: true },
    });

    if (!firm || firm.archivedAt !== null) {
      // 403 — never reveal whether the firm exists
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    // Look up membership for this user in this firm
    const membership = await prisma.firmMembership.findUnique({
      where: { firmId_userId: { firmId, userId: req.user.id } },
      select: { id: true, role: true, archivedAt: true },
    });

    // Option A: counselworks_admin bypasses membership requirement
    const isCwAdmin =
      membership?.role && CW_GLOBAL_ROLES.includes(membership.role as FirmRole);

    if (isCwAdmin && membership && !membership.archivedAt) {
      // cw_admin with active membership — grant access
      req.firmContext = {
        firmId,
        role: membership.role as FirmRole,
        membershipId: membership.id,
      };
      return next();
    }

    // Check if user is a cw_admin even without a membership in this specific firm
    // This handles the case where cw_admin doesn't have a membership row for every firm
    if (!membership) {
      // No membership at all — check if this user is a cw_admin in ANY firm
      const globalAdminMembership = await prisma.firmMembership.findFirst({
        where: {
          userId: req.user.id,
          role: { in: CW_GLOBAL_ROLES },
          archivedAt: null,
        },
        select: { id: true, role: true },
      });

      if (globalAdminMembership) {
        // cw_admin accessing a firm they have no specific membership for — allowed
        req.firmContext = {
          firmId,
          role: globalAdminMembership.role as FirmRole,
          membershipId: null, // no firm-specific membership
        };
        return next();
      }

      // No membership, not a cw_admin → 403
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    // Has a membership but it's archived → 403
    if (membership.archivedAt !== null) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
      return;
    }

    // Active membership — grant access
    req.firmContext = {
      firmId,
      role: membership.role as FirmRole,
      membershipId: membership.id,
    };

    next();
  };
}
