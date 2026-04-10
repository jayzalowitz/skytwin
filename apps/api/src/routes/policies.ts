import { Router } from 'express';
import { policyRepository } from '@skytwin/db';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';

/**
 * Create the policy CRUD router.
 *
 * Provides endpoints for managing user-specific action policies.
 */
export function createPoliciesRouter(): Router {
  const router = Router();
  bindUserIdParamOwnership(router);

  /**
   * GET /api/policies/:userId
   *
   * List all active policies for a user, optionally filtered by domain.
   */
  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const domain = req.query['domain'] as string | undefined;
      const policies = await policyRepository.getPoliciesForUser(userId, domain);

      res.json({
        policies: policies.map((p) => ({
          id: p.id,
          name: p.name,
          domain: p.domain,
          rules: p.rules,
          priority: p.priority,
          isActive: p.is_active,
          createdAt: p.created_at,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/policies/:userId
   *
   * Create a new policy for a user.
   */
  router.post('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const body = req.body as {
        name?: string;
        domain?: string;
        rules?: unknown[];
        priority?: number;
      };

      if (!body.name || typeof body.name !== 'string') {
        res.status(400).json({ error: 'Missing required field: name' });
        return;
      }

      if (!body.domain || typeof body.domain !== 'string') {
        res.status(400).json({ error: 'Missing required field: domain' });
        return;
      }

      const policy = await policyRepository.createPolicy({
        userId,
        name: body.name,
        domain: body.domain,
        rules: body.rules ?? [],
        priority: body.priority ?? 0,
      });

      res.status(201).json({
        id: policy.id,
        name: policy.name,
        domain: policy.domain,
        rules: policy.rules,
        priority: policy.priority,
        isActive: policy.is_active,
        createdAt: policy.created_at,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /api/policies/:userId/:policyId
   *
   * Update an existing policy.
   */
  router.put('/:userId/:policyId', async (req, res, next) => {
    try {
      const { policyId } = req.params;
      const body = req.body as {
        name?: string;
        domain?: string;
        rules?: unknown[];
        priority?: number;
        isActive?: boolean;
      };

      const updated = await policyRepository.updatePolicy(policyId, {
        name: body.name,
        domain: body.domain,
        rules: body.rules,
        priority: body.priority,
        isActive: body.isActive,
      });

      if (!updated) {
        res.status(404).json({ error: 'Policy not found' });
        return;
      }

      res.json({
        id: updated.id,
        name: updated.name,
        domain: updated.domain,
        rules: updated.rules,
        priority: updated.priority,
        isActive: updated.is_active,
        createdAt: updated.created_at,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /api/policies/:userId/:policyId
   *
   * Soft-delete a policy (marks as inactive).
   */
  router.delete('/:userId/:policyId', async (req, res, next) => {
    try {
      const { policyId } = req.params;
      const deleted = await policyRepository.deletePolicy(policyId);

      if (!deleted) {
        res.status(404).json({ error: 'Policy not found' });
        return;
      }

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
