import cookieParser from 'cookie-parser';
import express from 'express';
import authRouter from './routes/auth.routes';
import buildingRouter from './routes/building.routes';
import condominiumRouter from './routes/condominium.routes';
import expenseRouter from './routes/expense.routes';
import invitationRouter from './routes/invitation.routes';
import unitRouter from './routes/unit.routes';
import { errorHandler } from './middlewares/errorHandler';

/**
 * Express application factory — no `listen` here, so probes can mount it on
 * an ephemeral port in-process. `index.ts` is the only boot path.
 */
export function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/condominiums', condominiumRouter);
  app.use('/api/v1/buildings', buildingRouter);
  app.use('/api/v1/units', unitRouter);
  app.use('/api/v1/invitations', invitationRouter);
  app.use('/api/v1/expenses', expenseRouter);
  app.use(errorHandler);
  return app;
}

export default createApp;