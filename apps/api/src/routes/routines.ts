import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { ExecutionPlan, CandidateAction } from '@skytwin/shared-types';
import { TrustTier, ConfidenceLevel } from '@skytwin/shared-types';
import { PolicyEvaluator } from '@skytwin/policy-engine';
import { RiskAssessor } from '@skytwin/decision-engine';
import { userRepository, policyRepositoryAdapter } from '@skytwin/db';
import { getIronClawEnhancedAdapter } from '../execution-setup.js';
import { readAutonomy } from '../cost-gate.js';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import { bindUserIdParamValidator } from '../middleware/validate-uuid.js';

// Cron expression: 5 or 6 space-separated fields, each containing digits, *, /, -, or ,
const CRON_REGEX = /^[0-9*/,-]+( [0-9*/,-]+){4,5}$/;
const MAX_CRON_LENGTH = 128;

// A routine auto-executes unattended on a schedule, so it may ONLY schedule a
// known free + reversible action type. The cost/reversibility of these is
// classified server-side here, never trusted from the request body. Any other
// type is treated as unknown-cost + irreversible, which escalates to
// requiresApproval and is refused (an action needing per-run approval cannot
// run unattended). Outbound/costed/destructive actions are intentionally absent.
const FREE_ROUTINE_ACTION_TYPES = new Set<string>([
  'create_note',
  'create_document',
  'set_reminder',
  'snooze_reminder',
  'label_email',
  'archive_email',
  'acknowledge',
  'dismiss',
]);

export function createRoutinesRouter(): Router {
  const router = Router();
  bindUserIdParamValidator(router);
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
      // A routine auto-executes unattended on a schedule, so its action must
      // clear the FULL policy gate — including the spend hard-limit and the
      // reversibility / risk-dimension escalations, which only fire when BOTH a
      // riskAssessment and autonomySettings are supplied. The previous 3-arg
      // call silently skipped both, so a costed or irreversible plan.action
      // sailed through.
      // plan.action is untrusted request-body input, so the policy check runs
      // against a SERVER-DERIVED action — the caller never gets to assert its own
      // cost, reversibility, or provenance to slip past the gate. Cost +
      // reversibility are classified from the action TYPE: a known free + safe
      // type is verified-zero and reversible; anything else is unknown-cost and
      // assumed irreversible, so it escalates to requiresApproval and is refused.
      const rawAction = plan.action as Partial<CandidateAction>;
      const knownSafe = FREE_ROUTINE_ACTION_TYPES.has(plan.action.actionType);
      const action: CandidateAction = {
        id: typeof rawAction.id === 'string' ? rawAction.id : randomUUID(),
        decisionId: typeof rawAction.decisionId === 'string' ? rawAction.decisionId : '',
        actionType: plan.action.actionType,
        description: typeof rawAction.description === 'string' ? rawAction.description : '',
        domain: typeof rawAction.domain === 'string' ? rawAction.domain : 'general',
        parameters:
          rawAction.parameters && typeof rawAction.parameters === 'object' ? rawAction.parameters : {},
        estimatedCostCents: 0,
        costZeroIntent: knownSafe ? 'verified_zero' : 'unknown',
        reversible: knownSafe,
        confidence: ConfidenceLevel.LOW,
        reasoning: typeof rawAction.reasoning === 'string' ? rawAction.reasoning : 'Scheduled routine action',
        provenance: 'untrusted_external',
      };
      const riskAssessment = new RiskAssessor().assess(action);
      const autonomy = readAutonomy(user);
      const policyResult = await policyEvaluator.evaluate(
        action,
        policies,
        userTier,
        riskAssessment,
        autonomy,
      );

      if (!policyResult.allowed) {
        res.status(403).json({
          error: 'Routine blocked by policy.',
          reason: policyResult.reason ?? 'Policy check failed',
        });
        return;
      }
      // Otherwise allowed, but the policy engine says it needs human approval
      // (trust tier, cost, irreversibility, injection guard). A scheduled
      // routine has no human in the loop per run, so it must NOT be registered
      // to auto-run — refuse creation rather than silently auto-executing it.
      if (policyResult.requiresApproval) {
        res.status(403).json({
          error: 'Routine blocked: this action requires manual approval and cannot run unattended on a schedule.',
          reason: policyResult.reason ?? 'Action requires manual approval.',
        });
        return;
      }

      const adapter = await getIronClawEnhancedAdapter();
      if (!adapter) {
        res.status(503).json({ error: 'IronClaw routines are unavailable.' });
        return;
      }

      // Register the SERVER-NORMALIZED action — the exact object the policy gate
      // approved — and drop any caller-supplied steps/rollbackSteps, which were
      // never policy-checked. The executed routine therefore equals the checked
      // action; a caller cannot smuggle unchecked steps past the gate.
      const scopedPlan: ExecutionPlan = {
        id: randomUUID(),
        decisionId: '',
        action: { ...action, parameters: { ...action.parameters, userId } },
        steps: [],
        rollbackSteps: [],
        createdAt: new Date(),
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
