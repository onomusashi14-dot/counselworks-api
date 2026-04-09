/**
 * requireRole middleware
 * MUST run after authenticate + requireFirmAccess.
 *
 * Usage:
 *   router.patch('/:caseId',
 *     authenticate,
 *     requireFirmAccess(),
 *     requireRole('counselworks_admin', 'counselworks_operator'),
 *     handler
 *   );
 */

import { Request, Response, NextFunction } from 'express';
import { FirmRole } from '../types';

export function requireRole(...allowedRoles: FirmRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.firmContext) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Firm context missing. Ensure requireFirmAccess runs first.' },
      });
      return;
    }

    if (!allowedRoles.includes(req.firmContext.role as FirmRole)) {
      res.status(403).json({
        ok: false,
        error: { code: 'INSUFFICIENT_ROLE', message: 'You do not have permission to perform this action.' },
      });
      return;
    }

    next();
  };
}
