/**
 * prisma/cleanup-test-threads.ts
 *
 * Dev-only hard delete of junk threads accumulated during manual testing
 * (e.g. "ASDF", "sfasf", "dfasfasdfasfdas"). Seed threads are preserved.
 *
 * Identification rule:
 *   - Seed thread IDs use the prefix `30000000-` (see seed-portal.ts THREAD_IDS)
 *   - Any Request row on the dev firm `11111111-...` whose id does NOT start
 *     with `30000000-` is treated as a manual test submission and hard-deleted.
 *
 * This bypasses the soft-delete convention used in production because these
 * rows are not real case data — they were created by developers clicking
 * around the portal. In production, Request rows should never be hard-deleted.
 *
 * Usage:
 *   npx ts-node prisma/cleanup-test-threads.ts
 *
 * The script prints exactly what it is about to delete before doing it. If
 * the count is zero it exits without touching the database.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SEED_THREAD_PREFIX = '30000000-';
const DEV_FIRM_ID = '11111111-1111-1111-1111-111111111111';

async function cleanup(): Promise<void> {
  // Find all non-seed threads on the dev firm. Prisma's string operators
  // coerce @db.Uuid columns to text for comparison, so startsWith is valid.
  const candidates = await prisma.request.findMany({
    where: {
      firmId: DEV_FIRM_ID,
      NOT: { id: { startsWith: SEED_THREAD_PREFIX } },
    },
    select: { id: true, subject: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found ${candidates.length} non-seed thread(s) on firm ${DEV_FIRM_ID}:`);
  for (const t of candidates) {
    const ts = t.createdAt.toISOString().slice(0, 19).replace('T', ' ');
    console.log(`  [${ts}]  "${t.subject}"  (${t.id})`);
  }

  if (candidates.length === 0) {
    console.log('Nothing to clean up.');
    return;
  }

  // Delete child rows first to satisfy foreign key constraints.
  // request_messages FK → requests.id is ON DELETE RESTRICT in most setups,
  // so we walk them individually.
  let deletedMessages = 0;
  let deletedDrafts = 0;
  let deletedTasks = 0;
  let deletedThreads = 0;

  for (const thread of candidates) {
    const msgResult = await prisma.requestMessage.deleteMany({
      where: { requestId: thread.id },
    });
    deletedMessages += msgResult.count;

    // Drafts reference Request via requestId. If any test-created drafts
    // point at a junk thread, null the link rather than delete the draft —
    // draft rows may have real content.
    const draftUpdate = await prisma.draft.updateMany({
      where: { requestId: thread.id },
      data: { requestId: null },
    });
    deletedDrafts += draftUpdate.count;

    // Task's relation column is `threadId` (the Task model has no requestId).
    const taskUpdate = await prisma.task.updateMany({
      where: { threadId: thread.id },
      data: { threadId: null },
    });
    deletedTasks += taskUpdate.count;

    await prisma.request.delete({ where: { id: thread.id } });
    deletedThreads++;
  }

  console.log(
    `Deleted ${deletedThreads} test thread(s), ${deletedMessages} message(s); ` +
      `unlinked ${deletedDrafts} draft(s) and ${deletedTasks} task(s).`,
  );
}

cleanup()
  .catch((err) => {
    console.error('[cleanup-test-threads] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
