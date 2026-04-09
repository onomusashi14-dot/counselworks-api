/**
 * auditLog.ts
 * Raw SQL insert into activity_log — never uses Prisma.
 * The DB trigger prevents any UPDATE or DELETE on this table.
 * Audit failures are swallowed — never crash the main request.
 */

import { prisma } from '../config/prisma';

export interface LogActivityParams {
  firmId?: string;
  actorId?: string;
  actorType: 'attorney' | 'firm_staff' | 'counselworks_staff' | 'system' | 'ai';
  entityType: string;
  entityId: string;
  activityType: string;
  description: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

export async function logActivity(params: LogActivityParams): Promise<void> {
  const { firmId, actorId, actorType, entityType, entityId, activityType, description, ipAddress, metadata } = params;

  try {
    await prisma.$executeRaw`
      INSERT INTO activity_log
        (id, firm_id, actor_id, actor_type, entity_type, entity_id, activity_type, description, ip_address, metadata, created_at)
      VALUES
        (gen_random_uuid(),
         ${firmId ?? null}::uuid,
         ${actorId ?? null}::uuid,
         ${actorType},
         ${entityType},
         ${entityId}::uuid,
         ${activityType},
         ${description},
         ${ipAddress ?? null}::inet,
         ${metadata ? JSON.stringify(metadata) : null}::jsonb,
         NOW())
    `;
  } catch (err) {
    console.error('[AUDIT LOG FAILURE]', err);
  }
}
