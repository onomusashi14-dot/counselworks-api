/**
 * cleanup-junk-threads.ts
 *
 * Deletes every Request thread on dev firm 11111111-1111-1111-1111-111111111111
 * whose subject is NOT one of the four canonical seeded subjects below.
 *
 * Run order:
 *   1. Collect candidate thread IDs (by subject exclusion, firm-scoped).
 *   2. Unlink tasks.threadId and drafts.requestId that point at them (so the
 *      FK-less relations don't dangle after deletion).
 *   3. Delete request_messages for those threads (FK constraint).
 *   4. Delete the threads themselves.
 *
 * Run with:
 *   npx ts-node prisma/cleanup-junk-threads.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEV_FIRM_ID = '11111111-1111-1111-1111-111111111111';

const KEEP_SUBJECTS = [
  'Please review authorization form for Thompson records',
  'Escalation update — Metro Transit police report',
  'Draft demand package — Williams construction defect',
  'Questions for Martinez deposition prep',
];

async function cleanup(): Promise<void> {
  console.log('─'.repeat(72));
  console.log(`Cleaning junk threads on firm ${DEV_FIRM_ID}`);
  console.log('─'.repeat(72));
  console.log('Subjects to KEEP:');
  KEEP_SUBJECTS.forEach((s) => console.log(`  • ${s}`));
  console.log('');

  const candidates = await prisma.request.findMany({
    where: {
      firmId: DEV_FIRM_ID,
      subject: { notIn: KEEP_SUBJECTS },
    },
    select: { id: true, subject: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  if (candidates.length === 0) {
    console.log('No junk threads found. Nothing to delete.');
    return;
  }

  console.log(`Found ${candidates.length} junk thread${candidates.length === 1 ? '' : 's'} to delete:`);
  candidates.forEach((t) => {
    const subj = t.subject.length > 60 ? `${t.subject.slice(0, 60)}…` : t.subject;
    console.log(`  • [${t.id}] "${subj}" (${t.createdAt.toISOString()})`);
  });
  console.log('');

  const threadIds = candidates.map((t) => t.id);

  // Unlink tasks that reference these threads (Task.threadId, NOT requestId).
  const unlinkedTasks = await prisma.task.updateMany({
    where: { threadId: { in: threadIds } },
    data: { threadId: null },
  });
  console.log(`Unlinked ${unlinkedTasks.count} task(s) from junk threads.`);

  // Unlink drafts that reference these threads (Draft.requestId).
  const unlinkedDrafts = await prisma.draft.updateMany({
    where: { requestId: { in: threadIds } },
    data: { requestId: null },
  });
  console.log(`Unlinked ${unlinkedDrafts.count} draft(s) from junk threads.`);

  // Delete messages first (FK constraint on request_messages.request_id).
  const deletedMessages = await prisma.requestMessage.deleteMany({
    where: { requestId: { in: threadIds } },
  });
  console.log(`Deleted ${deletedMessages.count} message row(s).`);

  // Now the threads themselves.
  const deletedThreads = await prisma.request.deleteMany({
    where: { id: { in: threadIds } },
  });
  console.log(`Deleted ${deletedThreads.count} thread row(s).`);

  console.log('');
  console.log('Cleanup complete.');
}

cleanup()
  .catch((err) => {
    console.error('Cleanup failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
