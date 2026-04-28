import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { corsConfig } from './config/cors';
import { authRouter } from './modules/auth/auth.router';
import { firmsRouter } from './modules/firms/firms.router';
import { casesRouter } from './modules/cases/cases.router';
import { requestsRouter } from './modules/requests/requests.router';
import { leadsRouter } from './modules/requests/leads.router';
import { notificationsRouter } from './modules/notifications/notifications.router';
import { filesRouter } from './modules/files/files.router';
import { draftsRouter } from './modules/drafts/drafts.router';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(corsConfig);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Auth — no requireFirmAccess on these routes
  app.use('/auth', authRouter);

  app.use('/firms', firmsRouter);
  app.use('/firms/:firmId/cases', casesRouter);
  app.use('/firms/:firmId/requests', requestsRouter);
  app.use('/firms/:firmId/leads', leadsRouter);
  app.use('/firms/:firmId/drafts', draftsRouter);
  app.use('/notifications', notificationsRouter);
  app.use('/api/files', filesRouter);

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[ERROR]', err.message, err.stack);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
  });

  return app;
}
