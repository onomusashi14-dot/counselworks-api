// Load .env BEFORE any other import so every downstream module (ai-client,
// prisma, etc.) sees process.env as the user configured it. Prisma's own
// dotenv loader is an implementation detail and should not be relied on for
// non-DATABASE_URL variables.
import 'dotenv/config';

import { createApp } from './app';
import { cleanupPendingFiles } from './utils/files.cleanup';
import { startScheduler } from './modules/portal/scheduler';

const PORT = parseInt(process.env.PORT ?? '4000', 10);
const app = createApp();

app.listen(PORT, () => {
  console.log(`CounselWorks API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV ?? 'development'}`);
  console.log(`[AI] API key present: ${!!process.env.ANTHROPIC_API_KEY}`);
  if (process.env.ANTHROPIC_API_KEY) {
    const k = process.env.ANTHROPIC_API_KEY;
    console.log(`[AI] API key prefix: ${k.slice(0, 8)}... length=${k.length}`);
  } else {
    console.warn('[AI] WARNING: ANTHROPIC_API_KEY is not set. Thread interpretation will silently fall through to supervisor triage. Add ANTHROPIC_API_KEY=sk-ant-... to your .env and restart.');
  }
  // Portal automation jobs (escalation, thread auto-close, SLA) run every 15
  // minutes. Started here after the HTTP server is up so health checks and
  // migrations still work even if a job is broken.
  startScheduler();
});

// Run cleanup every 2 hours — archives orphaned pending file records
// No Redis/BullMQ required at Phase 4 — simple setInterval is sufficient
setInterval(cleanupPendingFiles, 2 * 60 * 60 * 1000);
// Run once at startup to catch any orphans from previous deploy
cleanupPendingFiles().catch(console.error);
