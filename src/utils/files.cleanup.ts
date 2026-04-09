/**
 * src/utils/files.cleanup.ts
 *
 * Archives pending file records older than 2 hours.
 * Writes a single activity_log entry per cleanup batch (system actor).
 * Physical S3 deletion is deferred to Phase 5.
 *
 * Run interval: every 2 hours via setInterval in server.ts
 */

import { prisma } from '../config/prisma';
import { logActivity } from './auditLog';

export async function cleanupPendingFiles(): Promise<void> {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);

  try {
    // Find IDs first so we can log them individually if needed
    const stale = await prisma.file.findMany({
      where: { status: 'pending', createdAt: { lt: cutoff } },
      select: { id: true, firmId: true, originalName: true },
    });

    if (stale.length === 0) return;

    // Archive in bulk
    await prisma.file.updateMany({
      where: { status: 'pending', createdAt: { lt: cutoff } },
      data: { status: 'archived', archivedAt: new Date() },
    });

    console.log(`[CLEANUP] Archived ${stale.length} orphaned pending file(s)`);

    // FIX 2: Write audit log for cleanup batch
    // Groups all orphaned files into one log entry per firm to avoid log spam
    const byFirm = stale.reduce<Record<string, string[]>>((acc, f) => {
      const fid = f.firmId ?? 'unknown';
      acc[fid] = acc[fid] ?? [];
      acc[fid].push(f.originalName);
      return acc;
    }, {});

    for (const [firmId, names] of Object.entries(byFirm)) {
      await logActivity({
        firmId:       firmId === 'unknown' ? undefined : firmId,
        actorId:      undefined,           // system actor — no user
        actorType:    'system',
        entityType:   'file',
        entityId:     stale[0].id,        // representative entity ID required by schema
        activityType: 'files_cleanup',
        description:  `System archived ${names.length} orphaned pending file(s): ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3} more` : ''}`,
        metadata:     { count: names.length, fileNames: names },
      });
    }
  } catch (err) {
    console.error('[CLEANUP] Failed to cleanup pending files:', err);
  }
}
