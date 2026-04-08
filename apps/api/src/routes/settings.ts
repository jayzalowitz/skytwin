import { Router } from 'express';
import {
  userRepository,
  domainAutonomyRepository,
  escalationTriggerRepository,
  aiProviderRepository,
} from '@skytwin/db';
import type { DomainAutonomyPolicyRow, EscalationTriggerRow, AIProviderSettingsRow } from '@skytwin/db';
import { TrustTier } from '@skytwin/shared-types';
import { LlmClient } from '@skytwin/llm-client';
import type { ProviderEntry } from '@skytwin/llm-client';

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

      const [domainPolicies, escalationTriggers, aiProviders] = await Promise.all([
        domainAutonomyRepository.getForUser(userId!),
        escalationTriggerRepository.getForUser(userId!),
        aiProviderRepository.getForUser(userId!),
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
        aiProviders: aiProviders.map((p: AIProviderSettingsRow) => ({
          provider: p.provider,
          model: p.model,
          baseUrl: p.base_url,
          priority: Number(p.priority),
          enabled: p.enabled,
          hasApiKey: p.api_key.length > 0,
          apiKeyPreview: p.api_key.length > 8 ? `${p.api_key.slice(0, 4)}${'•'.repeat(8)}${p.api_key.slice(-4)}` : (p.api_key.length > 0 ? '••••••••' : ''),
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

      // Validate spend limit values
      if (maxSpendPerActionCents !== undefined) {
        if (typeof maxSpendPerActionCents !== 'number' || maxSpendPerActionCents < 0) {
          res.status(400).json({ error: 'maxSpendPerActionCents must be a non-negative number' });
          return;
        }
      }
      if (maxDailySpendCents !== undefined) {
        if (typeof maxDailySpendCents !== 'number' || maxDailySpendCents < 0) {
          res.status(400).json({ error: 'maxDailySpendCents must be a non-negative number' });
          return;
        }
      }

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
      const { userId, triggerId } = req.params;
      const { enabled, conditions } = req.body as {
        enabled?: boolean;
        conditions?: Record<string, unknown>;
      };

      // Verify the trigger belongs to this user before updating
      const existing = await escalationTriggerRepository.findById(triggerId!);
      if (!existing || existing.user_id !== userId) {
        res.status(404).json({ error: 'Trigger not found' });
        return;
      }

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
      const { userId, triggerId } = req.params;

      // Verify the trigger belongs to this user before deleting
      const existing = await escalationTriggerRepository.findById(triggerId!);
      if (!existing || existing.user_id !== userId) {
        res.status(404).json({ error: 'Trigger not found' });
        return;
      }

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

  // ── AI Provider Settings ─────────────────────────────────────

  /**
   * PUT /api/settings/:userId/ai
   *
   * Save the user's full AI provider chain.
   * Replaces all existing providers atomically.
   */
  router.put('/:userId/ai', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const { providers } = req.body as {
        providers: {
          provider: string;
          apiKey?: string;
          model: string;
          baseUrl?: string;
          priority: number;
          enabled?: boolean;
        }[];
      };

      if (!Array.isArray(providers)) {
        res.status(400).json({ error: 'providers must be an array' });
        return;
      }

      const validProviders = new Set(['anthropic', 'openai', 'google', 'ollama']);
      for (const p of providers) {
        if (!validProviders.has(p.provider)) {
          res.status(400).json({ error: `Invalid provider: ${p.provider}` });
          return;
        }
        if (!p.model) {
          res.status(400).json({ error: `Model is required for provider ${p.provider}` });
          return;
        }
      }

      const rows = await aiProviderRepository.replaceAll(
        userId!,
        providers.map((p) => ({
          provider: p.provider,
          apiKey: p.apiKey,
          model: p.model,
          baseUrl: p.baseUrl,
          priority: p.priority,
          enabled: p.enabled,
        })),
      );

      res.json({
        providers: rows.map((r: AIProviderSettingsRow) => ({
          provider: r.provider,
          model: r.model,
          baseUrl: r.base_url,
          priority: Number(r.priority),
          enabled: r.enabled,
          hasApiKey: r.api_key.length > 0,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/settings/:userId/ai/test
   *
   * Test a single AI provider configuration.
   */
  router.post('/:userId/ai/test', async (req, res, _next) => {
    try {
      const { provider, apiKey, model, baseUrl } = req.body as {
        provider: string;
        apiKey?: string;
        model: string;
        baseUrl?: string;
      };

      const validProviders = new Set(['anthropic', 'openai', 'google', 'ollama']);
      if (!validProviders.has(provider)) {
        res.status(400).json({ error: `Invalid provider: ${provider}` });
        return;
      }

      const entry: ProviderEntry = {
        name: provider as ProviderEntry['name'],
        apiKey: apiKey ?? '',
        model,
        baseUrl,
      };

      const result = await LlmClient.testProvider(entry);
      res.json({ success: true, ...result, provider });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed';
      res.json({ success: false, error: message, provider: req.body?.provider });
    }
  });

  return router;
}
