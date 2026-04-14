import { Router } from 'express';
import type { ExecutionPlan } from '@skytwin/shared-types';
import { getIronClawEnhancedAdapter } from '../execution-setup.js';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';

export function createRoutinesRouter(): Router {
  const router = Router();
  bindUserIdParamOwnership(router);

  router.post('/', async (req, res, next) => {
    try {
      const { userId, schedule, plan } = req.body as {
        userId?: string;
        schedule?: string;
        plan?: ExecutionPlan;
      };

      if (!userId || !schedule || !plan) {
        res.status(400).json({ error: 'Missing required fields: userId, schedule, plan' });
        return;
      }

      const adapter = await getIronClawEnhancedAdapter();
      if (!adapter) {
        res.status(503).json({ error: 'IronClaw routines are unavailable.' });
        return;
      }

      const result = await adapter.createRoutine(schedule, plan);
      res.status(201).json({ userId, schedule, routineId: result.routineId });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const adapter = await getIronClawEnhancedAdapter();
      if (!adapter) {
        res.json({ userId, routines: [], available: false });
        return;
      }

      const routines = await adapter.listRoutines(userId);
      res.json({ userId, routines, available: true });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:routineId', async (req, res, next) => {
    try {
      const { routineId } = req.params;
      const adapter = await getIronClawEnhancedAdapter();
      if (!adapter) {
        res.status(503).json({ error: 'IronClaw routines are unavailable.' });
        return;
      }

      const result = await adapter.deleteRoutine(routineId!);
      res.json({ routineId, deleted: result.success });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
