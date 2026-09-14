import { Router } from 'express';
import {
  userRepository,
  domainAutonomyRepository,
  escalationTriggerRepository,
  aiProviderRepository,
  reasoningModeRepository,
} from '@skytwin/db';
import type { DomainAutonomyPolicyRow, EscalationTriggerRow, AIProviderSettingsRow } from '@skytwin/db';
import {
  hasSameProviderCredentialEndpoint,
  parseReasoningMode,
  TrustTier,
} from '@skytwin/shared-types';
import type { AIProviderName, ReasoningMode } from '@skytwin/shared-types';
import {
  SKYTWIN_EMAIL_ATTRIBUTION_TEXT,
  SKYTWIN_REPO_URL,
  resolveEmailAttributionEnabled,
} from '@skytwin/shared-types';
import {
  LlmClient,
  providerPrivacyCapabilities,
  providersForReasoningMode,
  validateBaseUrl,
  validateBaseUrlWithDns,
} from '@skytwin/llm-client';
import type { ProviderEntry } from '@skytwin/llm-client';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import { bindUserIdParamValidator } from '../middleware/validate-uuid.js';

const VALID_IRONCLAW_CHANNEL = /^[a-zA-Z0-9_.:-]{1,64}$/;
const VALID_AI_PROVIDERS = new Set<AIProviderName>([
  'anthropic', 'openai', 'google', 'ollama', 'embedded',
]);

function providerEntryFromRow(row: AIProviderSettingsRow): ProviderEntry | null {
  if (!VALID_AI_PROVIDERS.has(row.provider as AIProviderName)) return null;
  return {
    name: row.provider as AIProviderName,
    apiKey: row.api_key,
    model: row.model,
    baseUrl: row.base_url ?? undefined,
  };
}

function modePolicyError(
  mode: ReasoningMode,
  providers: readonly ProviderEntry[],
): string | null {
  if (mode === 'verified_private_cloud') {
    return 'Verified private cloud requires a verifier-owned provider adapter';
  }
  if (providers.length === 0) return null;
  try {
    providersForReasoningMode(mode, providers);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Provider chain is incompatible with reasoning mode';
  }
}

/**
 * Create the settings router for user autonomy configuration.
 */
export function createSettingsRouter(): Router {
  const router = Router();
  bindUserIdParamValidator(router);
  bindUserIdParamOwnership(router);

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

      const [domainPolicies, escalationTriggers, aiSnapshot] = await Promise.all([
        domainAutonomyRepository.getForUser(userId!),
        escalationTriggerRepository.getForUser(userId!),
        aiProviderRepository.getReasoningSnapshotForUser(userId!),
      ]);
      const aiProviders = aiSnapshot.providers;
      const reasoningMode = aiSnapshot.reasoningMode;

      res.json({
        userId: user.id,
        trustTier: user.trust_tier,
        ironclawChannel: user.ironclaw_channel ?? 'skytwin',
        ironclawChannels: ['skytwin', 'telegram', 'discord', 'slack', 'signal'],
        autonomySettings: user.autonomy_settings,
        emailAttribution: {
          enabled: resolveEmailAttributionEnabled(user.autonomy_settings),
          text: SKYTWIN_EMAIL_ATTRIBUTION_TEXT,
          repoUrl: SKYTWIN_REPO_URL,
        },
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
        aiProviders: aiProviders.map((p: AIProviderSettingsRow) => {
          const entry = providerEntryFromRow(p);
          return {
            provider: p.provider,
            model: p.model,
            baseUrl: p.base_url,
            priority: Number(p.priority),
            enabled: p.enabled,
            hasApiKey: p.api_key.length > 0,
            apiKeyPreview: p.api_key.length > 8 ? `${p.api_key.slice(0, 4)}${'•'.repeat(8)}${p.api_key.slice(-4)}` : (p.api_key.length > 0 ? '••••••••' : ''),
            privacy: entry ? providerPrivacyCapabilities(entry) : null,
          };
        }),
        reasoningMode: {
          mode: reasoningMode.mode,
          requiresConfirmation: reasoningMode.requires_confirmation,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /api/settings/:userId/ironclaw-channel
   *
   * Update the user's preferred IronClaw channel for execution routing.
   */
  router.put('/:userId/ironclaw-channel', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const { ironclawChannel } = req.body as { ironclawChannel?: string };

      if (!ironclawChannel || !VALID_IRONCLAW_CHANNEL.test(ironclawChannel)) {
        res.status(400).json({
          error: 'Invalid IronClaw channel. Use 1-64 letters, numbers, dot, underscore, colon, or dash characters.',
        });
        return;
      }

      const updated = await userRepository.updateIronClawChannel(userId!, ironclawChannel);
      if (!updated) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      res.json({
        userId: updated.id,
        ironclawChannel: updated.ironclaw_channel ?? 'skytwin',
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
        emailAttributionSignatureEnabled,
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
      if (
        emailAttributionSignatureEnabled !== undefined &&
        typeof emailAttributionSignatureEnabled !== 'boolean'
      ) {
        res.status(400).json({ error: 'emailAttributionSignatureEnabled must be a boolean' });
        return;
      }

      const updatedSettings: Record<string, unknown> = {
        ...user.autonomy_settings,
      };

      if (maxSpendPerActionCents !== undefined) updatedSettings['maxSpendPerActionCents'] = maxSpendPerActionCents;
      if (maxDailySpendCents !== undefined) updatedSettings['maxDailySpendCents'] = maxDailySpendCents;
      if (allowedDomains !== undefined) updatedSettings['allowedDomains'] = allowedDomains;
      if (blockedDomains !== undefined) updatedSettings['blockedDomains'] = blockedDomains;
      if (requireApprovalForIrreversible !== undefined) updatedSettings['requireApprovalForIrreversible'] = requireApprovalForIrreversible;
      if (emailAttributionSignatureEnabled !== undefined) {
        updatedSettings['emailAttributionSignatureEnabled'] = emailAttributionSignatureEnabled;
      }

      const updated = await userRepository.updateAutonomySettings(userId!, updatedSettings);

      if (!updated) {
        res.status(404).json({ error: 'Failed to update settings' });
        return;
      }

      res.json({
        userId: updated.id,
        autonomySettings: updated.autonomy_settings,
        emailAttribution: {
          enabled: resolveEmailAttributionEnabled(updated.autonomy_settings),
          text: SKYTWIN_EMAIL_ATTRIBUTION_TEXT,
          repoUrl: SKYTWIN_REPO_URL,
        },
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

  /** Persist an explicit reasoning-location choice independently of providers. */
  router.put('/:userId/ai/reasoning-mode', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const mode = parseReasoningMode((req.body as Record<string, unknown>)['mode']);
      if (!mode) {
        res.status(400).json({
          error: 'mode must be on_device, verified_private_cloud, or bring_your_own_provider',
        });
        return;
      }
      const row = await reasoningModeRepository.setForUserIfCompatible(userId!, mode);
      if (!row) {
        res.status(409).json({
          error: 'The active provider chain is not compatible with that reasoning mode',
        });
        return;
      }
      res.json({ mode: row.mode, requiresConfirmation: row.requires_confirmation });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /api/settings/:userId/ai
   *
   * Save the user's full AI provider chain.
   * Replaces all existing providers atomically.
   */
  router.put('/:userId/ai', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const { providers, reasoningMode: requestedModeValue } = req.body as {
        providers: {
          provider: string;
          apiKey?: string;
          model: string;
          baseUrl?: string | null;
          priority: number;
          enabled?: boolean;
        }[];
        reasoningMode?: unknown;
      };

      if (!Array.isArray(providers)) {
        res.status(400).json({ error: 'providers must be an array' });
        return;
      }

      // #187 AC#6 / AC#7: `embedded` is a first-class provider in the
      // LlmClient chain (landed in PR #241) and the Smart-mode toggle in
      // settings.js relies on PUT-ing an `embedded` entry here. Pre-AC#6
      // this set only listed hosted + ollama, so the Smart pill round-
      // tripped through `applySmartMode` and then 400'd at the API.
      // Copilot caught this on PR #253.
      const seenProviders = new Set<string>();
      for (const p of providers) {
        if (!VALID_AI_PROVIDERS.has(p.provider as AIProviderName)) {
          res.status(400).json({ error: `Invalid provider: ${p.provider}` });
          return;
        }
        if (!p.model) {
          res.status(400).json({ error: `Model is required for provider ${p.provider}` });
          return;
        }
        if (seenProviders.has(p.provider)) {
          res.status(400).json({ error: `Duplicate provider: ${p.provider}. Each provider can only appear once.` });
          return;
        }
        seenProviders.add(p.provider);
        if (p.baseUrl) {
          try {
            if (p.enabled === false) {
              validateBaseUrl(p.baseUrl, p.provider);
            } else {
              await validateBaseUrlWithDns(p.baseUrl, p.provider);
            }
          } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid base URL' });
            return;
          }
        }
      }

      const requestedMode = parseReasoningMode(requestedModeValue);
      if (requestedMode === null) {
        res.status(400).json({
          error: 'reasoningMode is required and must be a canonical reasoning mode',
        });
        return;
      }
      const targetMode = requestedMode;
      const enabledEntries: ProviderEntry[] = providers
        .filter((provider) => provider.enabled !== false)
        .map((provider) => ({
          name: provider.provider as AIProviderName,
          apiKey: provider.apiKey ?? '',
          model: provider.model,
          baseUrl: provider.baseUrl ?? undefined,
        }));
      const policyError = modePolicyError(targetMode, enabledEntries);
      if (policyError) {
        res.status(409).json({ error: policyError });
        return;
      }

      let rows: AIProviderSettingsRow[];
      try {
        rows = await aiProviderRepository.replaceAllWithReasoningMode(
          userId!,
          targetMode,
          providers.map((p) => ({
            provider: p.provider,
            apiKey: p.apiKey,
            model: p.model,
            baseUrl: p.baseUrl ?? undefined,
            priority: p.priority,
            enabled: p.enabled,
          })),
        );
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'provider_credential_endpoint_changed') {
          res.status(409).json({
            error: 'Enter a fresh API key when changing a provider endpoint.',
          });
          return;
        }
        throw error;
      }

      res.json({
        reasoningMode: targetMode,
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
      const { userId } = req.params;
      const { provider, apiKey, model, baseUrl, reasoningMode: requestedModeValue } = req.body as {
        provider: string;
        apiKey?: string;
        model: string;
        baseUrl?: string | null;
        reasoningMode?: unknown;
      };

      const validProviders = new Set(['anthropic', 'openai', 'google', 'ollama']);
      if (!validProviders.has(provider)) {
        res.status(400).json({ error: `Invalid provider: ${provider}` });
        return;
      }

      if (apiKey !== undefined && typeof apiKey !== 'string') {
        res.status(400).json({ success: false, error: 'apiKey must be a string', provider });
        return;
      }

      // A masked/omitted key can be reused only for the same network authority.
      // Otherwise this endpoint would disclose a stored secret to a new host.
      let resolvedKey = apiKey ?? '';
      if (!resolvedKey && userId) {
        const rows = await aiProviderRepository.getForUser(userId);
        const stored = rows.find((r) => r.provider === provider);
        if (stored?.api_key && !hasSameProviderCredentialEndpoint(
          provider as AIProviderName,
          stored.base_url,
          baseUrl,
        )) {
          res.status(409).json({
            success: false,
            error: 'Enter a fresh API key when testing a different provider endpoint.',
            provider,
          });
          return;
        }
        resolvedKey = stored?.api_key ?? '';
      }

      const entry: ProviderEntry = {
        name: provider as ProviderEntry['name'],
        apiKey: resolvedKey,
        model,
        baseUrl: baseUrl ?? undefined,
      };

      if (baseUrl) {
        try {
          await validateBaseUrlWithDns(baseUrl, provider);
        } catch (error) {
          res.status(400).json({
            success: false,
            error: error instanceof Error ? error.message : 'Invalid base URL',
            provider,
          });
          return;
        }
      }

      const setting = await reasoningModeRepository.getOrCreateForUser(userId!);
      const requestedMode = requestedModeValue === undefined
        ? null
        : parseReasoningMode(requestedModeValue);
      if (requestedModeValue !== undefined && requestedMode === null) {
        res.status(400).json({ success: false, error: 'Invalid reasoning mode', provider });
        return;
      }
      const targetMode = requestedMode ?? setting.mode;
      if (!targetMode || (requestedMode === null && setting.requires_confirmation)) {
        res.status(409).json({
          success: false,
          error: 'Choose a reasoning mode before testing a provider',
          provider,
        });
        return;
      }
      const result = await LlmClient.testProviderForReasoningMode(targetMode, entry);
      res.json({ success: true, ...result, provider });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed';
      res.json({ success: false, error: message, provider: req.body?.provider });
    }
  });

  return router;
}
