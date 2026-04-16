import { Router } from 'express';
import type { ExecutionPlan } from '@skytwin/shared-types';
import { TrustTier } from '@skytwin/shared-types';
import { PolicyEvaluator } from '@skytwin/policy-engine';
import { userRepository, policyRepositoryAdapter } from '@skytwin/db';
import { getIronClawEnhancedAdapter } from '../execution-setup.js';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';

// Cron expression: 5 or 6 space-separated fields, each containing digits, *, /, -, or ,
const CRON_REGEX = /^[0-9*/,-]+( [0-9*/,-]+){4,5}$/;
const MAX_CRON_LENGTH = 128;

export function createRoutinesRouter(): Router {
  const router = Router();
  bindUserIdParamOwnership(router);
  const policyEvaluator = new PolicyEvaluator(policyRepositoryAdapter);

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

      // Validate cron schedule format
      if (schedule.length > MAX_CRON_LENGTH || !CRON_REGEX.test(schedule)) {
        res.status(400).json({ error: 'Invalid schedule format. Expected a cron expression (e.g., "0 9 * * *").' });
        return;
      }

      // Validate plan has a well-formed action
      if (!plan.action || !plan.action.actionType) {
        res.status(400).json({ error: 'Plan must include an action with an actionType.' });
        return;
      }

      // Policy check: routines auto-execute, so must pass policy evaluation
      const user = await userRepository.findById(userId);
      if (!user) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }
      const userTier = user.trust_tier as TrustTier ?? TrustTier.OBSERVER;
      const policies = await policyRepositoryAdapter.getAllPolicies();
      const policyResult = await policyEvaluator.evaluate(plan.action, policies, userTier);

      if (policyResult && !policyResult.allowed) {
        res.status(403).json({
          error: 'Routine blocked by policy.',
          reason: policyResult.reason ?? 'Policy check failed',
        });
        return;
      }

      const adapter = await getIronClawEnhancedAdapter();
      if (!adapter) {
        res.status(503).json({ error: 'IronClaw routines are unavailable.' });
        return;
      }

      const scopedPlan: ExecutionPlan = {
        ...plan,
        action: {
          ...plan.action,
          parameters: {
            ...plan.action.parameters,
            userId,
          },
        },
      };

      const result = await adapter.createRoutine(userId, schedule, scopedPlan);
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
      const bodyUserId = (req.body as Record<string, unknown>)?.['userId'];
      const queryUserId = req.query['userId'];
      const userId = typeof bodyUserId === 'string' ? bodyUserId
        : typeof queryUserId === 'string' ? queryUserId
        : undefined;
      if (!userId) {
        res.status(400).json({ error: 'Missing required userId' });
        return;
      }

      const adapter = await getIronClawEnhancedAdapter();
      if (!adapter) {
        res.status(503).json({ error: 'IronClaw routines are unavailable.' });
        return;
      }

      // Verify the routine belongs to the requesting user before deleting
      const routines = await adapter.listRoutines(userId);
      const owns = routines.some((r) => r.id === routineId);
      if (!owns) {
        res.status(403).json({ error: 'Routine not found or does not belong to you.' });
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
