/**
 * src/modules/portal/scheduler.ts
 *
 * Runs the portal automation jobs on a simple setInterval. No Redis/BullMQ
 * required at this phase — one process, in-memory, resets on deploy.
 *
 * Jobs (every 15 minutes, serialized):
 *   1. Escalation check  — medical record request day-based schedule
 *   2. Thread auto-close — pending_attorney threads > 48h with no reply
 *   3. SLA check         — task breaches + attorney response overdue
 *
 * The jobs are wrapped in try/catch individually so one failing job cannot
 * block the others. Timing and counts are logged so we can spot-check in the
 * server logs.
 *
 * Call startScheduler() once from server.ts after app.listen().
 */

import { prisma } from '../../config/prisma';
import { runEscalationCheck } from './escalation.service';
import { runThreadAutoClose } from './thread-autoclose.service';
import { runSLACheck } from './sla.service';

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

let running = false;

async function runAllJobs(): Promise<void> {
  if (running) {
    console.log('[scheduler] previous tick still running — skipping');
    return;
  }
  running = true;
  const start = Date.now();
  try {
    try {
      const esc = await runEscalationCheck(prisma);
      console.log('[scheduler] escalation', esc);
    } catch (err) {
      console.error('[scheduler] escalation failed', err);
    }

    try {
      const close = await runThreadAutoClose(prisma);
      console.log('[scheduler] thread-autoclose', close);
    } catch (err) {
      console.error('[scheduler] thread-autoclose failed', err);
    }

    try {
      const sla = await runSLACheck(prisma);
      console.log('[scheduler] sla', sla);
    } catch (err) {
      console.error('[scheduler] sla failed', err);
    }
  } finally {
    running = false;
    console.log(`[scheduler] tick finished in ${Date.now() - start}ms`);
  }
}

export function startScheduler(): void {
  // Kick once on boot so a freshly deployed instance reflects current state
  // without waiting 15 minutes.
  runAllJobs().catch((err) => console.error('[scheduler] initial run failed', err));
  setInterval(() => {
    runAllJobs().catch((err) => console.error('[scheduler] interval run failed', err));
  }, INTERVAL_MS);
  console.log(`[scheduler] started — runs every ${INTERVAL_MS / 60_000} minutes`);
}
