import { Router } from 'express';
import {
  userRepository,
  domainAutonomyRepository,
  escalationTriggerRepository,
} from '@skytwin/db';
import type { DomainAutonomyPolicyRow, EscalationTriggerRow } from '@skytwin/db';
import { TrustTier } from '@skytwin/shared-types';

/**
 * Create the settings router for user autonomy configuration.
 */
export function createSettingsRouter(): Router {
  const router = Router();

  /**
   * GET /api/settings/:userId
   *
   * Return the user's complete settings: trust tier, autonomy settings,
   * domain overrides, and escalation triggers.
   */
  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const user = await userRepository.findById(userId!);

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const [domainPolicies, escalationTriggers] = await Promise.all([
        domainAutonomyRepository.getForUser(userId!),
        escalationTriggerRepository.getForUser(userId!),
      ]);

      res.json({
        userId: user.id,
        trustTier: user.trust_tier,
        autonomySettings: user.autonomy_settings,
        domainPolicies: domainPolicies.map((p: DomainAutonomyPolicyRow) => ({
          domain: p.domain,
          trustTier: p.trust_tier,
          maxSpendPerActionCents: p.max_spend_per_action_cents,
        })),
        escalationTriggers: escalationTriggers.map((t: EscalationTriggerRow) => ({
          id: t.id,
          triggerType: t.trigger_type,
          conditions: t.conditions,
          enabled: t.enabled,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /api/settings/:userId/autonomy
   *
   * Update user autonomy settings (spend limits, domain lists, etc.)
   */
  router.put('/:userId/autonomy', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const user = await userRepository.findById(userId!);

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const {
        maxSpendPerActionCents,
        maxDailySpendCents,
        allowedDomains,
        blockedDomains,
        requireApprovalForIrreversible,
      } = req.body as Record<string, unknown>;

      const updatedSettings: Record<string, unknown> = {
        ...user.autonomy_settings,
      };

      if (maxSpendPerActionCents !== undefined) updatedSettings['maxSpendPerActionCents'] = maxSpendPerActionCents;
      if (maxDailySpendCents !== undefined) updatedSettings['maxDailySpendCents'] = maxDailySpendCents;
      if (allowedDomains !== undefined) updatedSettings['allowedDomains'] = allowedDomains;
      if (blockedDomains !== undefined) updatedSettings['blockedDomains'] = blockedDomains;
      if (requireApprovalForIrreversible !== undefined) updatedSettings['requireApprovalForIrreversible'] = requireApprovalForIrreversible;

      const updated = await userRepository.updateAutonomySettings(userId!, updatedSettings);

      if (!updated) {
        res.status(404).json({ error: 'Failed to update settings' });
        return;
      }

      res.json({
        userId: updated.id,
        autonomySettings: updated.autonomy_settings,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /api/settings/:userId/domains/:domain
   *
   * Set or update a domain-specific trust tier override.
   */
  router.put('/:userId/domains/:domain', async (req, res, next) => {
    try {
      const { userId, domain } = req.params;
      const { trustTier, maxSpendPerActionCents } = req.body as {
        trustTier: string;
        maxSpendPerActionCents?: number;
      };

      // Validate trust tier
      const validTiers = Object.values(TrustTier) as string[];
      if (!validTiers.includes(trustTier)) {
        res.status(400).json({
          error: `Invalid trust tier: ${trustTier}. Must be one of: ${validTiers.join(', ')}`,
        });
        return;
      }

      const policy = await domainAutonomyRepository.upsert({
        userId: userId!,
        domain: domain!,
        trustTier,
        maxSpendPerActionCents,
      });

      res.json({
        domain: policy.domain,
        trustTier: policy.trust_tier,
        maxSpendPerActionCents: policy.max_spend_per_action_cents,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /api/settings/:userId/domains/:domain
   *
   * Remove a domain-specific override, falling back to global tier.
   */
  router.delete('/:userId/domains/:domain', async (req, res, next) => {
    try {
      const { userId, domain } = req.params;
      const deleted = await domainAutonomyRepository.delete(userId!, domain!);

      if (!deleted) {
        res.status(404).json({ error: 'Domain policy not found' });
        return;
      }

      res.json({ deleted: true, domain });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/settings/:userId/escalation-triggers
   *
   * Create a new escalation trigger for the user.
   */
  router.post('/:userId/escalation-triggers', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const { triggerType, conditions, enabled } = req.body as {
        triggerType: string;
        conditions: Record<string, unknown>;
        enabled?: boolean;
      };

      const validTypes = [
        'amount_threshold',
        'risk_tier_threshold',
        'low_confidence',
        'novel_situation',
        'consecutive_rejections',
      ];
      if (!validTypes.includes(triggerType)) {
        res.status(400).json({
          error: `Invalid trigger type: ${triggerType}. Must be one of: ${validTypes.join(', ')}`,
        });
        return;
      }

      const trigger = await escalationTriggerRepository.create({
        userId: userId!,
        triggerType,
        conditions: conditions ?? {},
        enabled,
      });

      res.status(201).json({
        id: trigger.id,
        triggerType: trigger.trigger_type,
        conditions: trigger.conditions,
        enabled: trigger.enabled,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PATCH /api/settings/:userId/escalation-triggers/:triggerId
   *
   * Update an escalation trigger's enabled state or conditions.
   */
  router.patch('/:userId/escalation-triggers/:triggerId', async (req, res, next) => {
    try {
      const { triggerId } = req.params;
      const { enabled, conditions } = req.body as {
        enabled?: boolean;
        conditions?: Record<string, unknown>;
      };

      const updated = await escalationTriggerRepository.update(triggerId!, {
        enabled,
        conditions,
      });

      if (!updated) {
        res.status(404).json({ error: 'Trigger not found' });
        return;
      }

      res.json({
        id: updated.id,
        triggerType: updated.trigger_type,
        conditions: updated.conditions,
        enabled: updated.enabled,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /api/settings/:userId/escalation-triggers/:triggerId
   *
   * Delete an escalation trigger.
   */
  router.delete('/:userId/escalation-triggers/:triggerId', async (req, res, next) => {
    try {
      const { triggerId } = req.params;
      const deleted = await escalationTriggerRepository.delete(triggerId!);

      if (!deleted) {
        res.status(404).json({ error: 'Trigger not found' });
        return;
      }

      res.json({ deleted: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
