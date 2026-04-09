import { createApp } from './app';
import { cleanupPendingFiles } from './utils/files.cleanup';

const PORT = parseInt(process.env.PORT ?? '4000', 10);
const app = createApp();

app.listen(PORT, () => {
  console.log(`CounselWorks API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV ?? 'development'}`);
});

// Run cleanup every 2 hours — archives orphaned pending file records
// No Redis/BullMQ required at Phase 4 — simple setInterval is sufficient
setInterval(cleanupPendingFiles, 2 * 60 * 60 * 1000);
// Run once at startup to catch any orphans from previous deploy
cleanupPendingFiles().catch(console.error);
