import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { TwinService } from '@skytwin/twin-model';
import { TwinRepositoryAdapter, PatternRepositoryAdapter, feedbackRepository, userRepository } from '@skytwin/db';
import { ConfidenceLevel, PROMOTION_THRESHOLDS } from '@skytwin/shared-types';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import { bindUserIdParamValidator } from '../middleware/validate-uuid.js';

/**
 * Create the twin management router.
 */
export function createTwinRouter(): Router {
  const router = Router();
  bindUserIdParamValidator(router);
  bindUserIdParamOwnership(router);
  const twinService = new TwinService(new TwinRepositoryAdapter(), new PatternRepositoryAdapter());

  /**
   * GET /api/twin/export/:userId
   *
   * Export the complete twin profile as JSON or Markdown.
   * Query param: ?format=json (default) or ?format=markdown
   *
   * NOTE: This route must be defined before /:userId to avoid
   * Express matching "export" as a userId parameter.
   */
  router.get('/export/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const format = (req.query['format'] as string) === 'markdown' ? 'markdown' : 'json';
      const exportData = await twinService.exportTwin(userId, format);

      if (format === 'markdown') {
        const markdown = twinService.formatAsMarkdown(exportData);
        res.setHeader('Content-Type', 'text/markdown');
        res.send(markdown);
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.json(exportData);
      }
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/twin/:userId
   *
   * Get the current twin profile for a user.
   */
  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const profile = await twinService.getOrCreateProfile(userId);

      res.json({
        profile: {
          id: profile.id,
          userId: profile.userId,
          version: profile.version,
          preferencesCount: profile.preferences.length,
          inferencesCount: profile.inferences.length,
          preferences: profile.preferences,
          inferences: profile.inferences,
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /api/twin/:userId/preferences
   *
   * Update preferences for a user's twin profile.
   */
  router.put('/:userId/preferences', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const body = req.body as {
        domain: string;
        key: string;
        value: unknown;
        confidence?: string;
        source?: string;
      };

      if (!body.domain || !body.key) {
        res.status(400).json({ error: 'Missing required fields: domain, key' });
        return;
      }

      const preference = {
        id: `pref_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        domain: body.domain,
        key: body.key,
        value: body.value,
        confidence: (body.confidence as ConfidenceLevel) ?? ConfidenceLevel.MODERATE,
        source: (body.source as 'explicit' | 'inferred' | 'default' | 'corrected') ?? 'explicit',
        evidenceIds: [] as string[],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updatedProfile = await twinService.updatePreference(userId, preference);

      res.json({
        profile: {
          id: updatedProfile.id,
          version: updatedProfile.version,
          preferencesCount: updatedProfile.preferences.length,
        },
        updatedPreference: preference,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/twin/:userId/progress
   *
   * Trust tier progress: returns the metrics the policy engine actually
   * uses for promotion decisions. The dashboard's trust-progress bar
   * keys off `consecutiveApprovals` (resets on rejection) rather than
   * cumulative `approvalCount`, because that's what the engine
   * (`packages/policy-engine/src/trust-tier-engine.ts`) gates promotion
   * on. Cumulative count is kept for display-only purposes.
   *
   * `nextTierThreshold` is null when the user is at MODERATE_AUTONOMY or
   * HIGH_AUTONOMY — promotion to HIGH_AUTONOMY is explicit opt-in only,
   * so the UI should render "Maximum trust" instead of a false "100
   * approvals to unlock" target.
   */
  router.get('/:userId/progress', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const user = await userRepository.findById(userId);
      const currentTier = user?.trust_tier ?? 'observer';

      // Pull recent feedback. `findByUser` orders by created_at DESC, so
      // index 0 is the freshest event. We compute consecutiveApprovals
      // by walking forward from the freshest event until we hit a
      // non-approval — that's what the policy engine does when deciding
      // whether to promote.
      const feedback = await feedbackRepository.findByUser(userId, { limit: 1000 });
      const approvalCount = feedback.filter((f) => f.type === 'approve').length;
      const rejectionCount = feedback.filter((f) => f.type === 'reject').length;

      let consecutiveApprovals = 0;
      for (let i = 0; i < feedback.length; i++) {
        const f = feedback[i];
        if (f && f.type === 'approve') {
          consecutiveApprovals++;
        } else {
          break;
        }
      }

      const totalDecided = approvalCount + rejectionCount;
      const approvalRatio = totalDecided > 0 ? approvalCount / totalDecided : 0;

      // Single source of truth: PROMOTION_THRESHOLDS from shared-types.
      // No entry for moderate_autonomy or high_autonomy → null target.
      const tierConfig = PROMOTION_THRESHOLDS[currentTier];
      const nextTierThreshold = tierConfig?.consecutiveApprovals ?? null;
      const minApprovalRatio = tierConfig?.minApprovalRatio ?? null;
      const nextTier = tierConfig?.nextTier ?? null;

      res.json({
        currentTier,
        // Display-only — the cumulative count for "you've approved N
        // things" copy. Not the metric promotion is gated on.
        approvalCount,
        // The actual promotion metric. Resets on rejection.
        consecutiveApprovals,
        // The other promotion metric. Both must be met for the engine
        // to promote.
        approvalRatio,
        minApprovalRatio,
        nextTier,
        // null when the current tier has no automatic promotion
        // (MODERATE_AUTONOMY → HIGH_AUTONOMY requires explicit opt-in).
        nextTierThreshold,
        // Backwards-compat alias for older clients that read `threshold`.
        threshold: nextTierThreshold,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /api/twin/:userId/insights
   *
   * Remove (or correct) a preference or inference from the twin profile.
   * Body: { domain, key, newValue? }
   *   - If newValue is provided, updates the matching insight to use that value.
   *   - If newValue is omitted/empty, removes the matching insight entirely.
   */
  router.delete('/:userId/insights', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }

      const body = req.body as { domain: string; key: string; newValue?: string };
      if (!body.domain || !body.key) {
        res.status(400).json({ error: 'Missing required fields: domain, key' });
        return;
      }

      if (body.domain.length > 64 || body.key.length > 128 || (body.newValue && body.newValue.length > 10000)) {
        res.status(400).json({ error: 'Field length exceeds limit' });
        return;
      }

      const profile = await twinService.getOrCreateProfile(userId);

      // Filter out matching inference in both paths
      const filteredInferences = profile.inferences.filter(
        (inf) => !(inf.domain === body.domain && inf.key === body.key),
      );

      let updated;
      if (body.newValue && body.newValue.trim()) {
        // Correct: replace matching pref with corrected value, drop matching inference
        const correctedPref = {
          id: `pref_${Date.now()}_${randomUUID().slice(0, 8)}`,
          domain: body.domain,
          key: body.key,
          value: body.newValue.trim(),
          confidence: ConfidenceLevel.CONFIRMED,
          source: 'corrected' as const,
          evidenceIds: [] as string[],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const updatedPrefs = profile.preferences.filter(
          (p) => !(p.domain === body.domain && p.key === body.key),
        );
        updatedPrefs.push(correctedPref);
        updated = await twinService.replaceProfileInsights(userId, updatedPrefs, filteredInferences);
      } else {
        // Remove: drop the matching preference and inference
        const filteredPrefs = profile.preferences.filter(
          (p) => !(p.domain === body.domain && p.key === body.key),
        );
        updated = await twinService.replaceProfileInsights(userId, filteredPrefs, filteredInferences);
      }

      res.json({
        profile: {
          id: updated.id,
          version: updated.version,
          preferencesCount: updated.preferences.length,
          inferencesCount: updated.inferences.length,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/twin/:userId/learned
   *
   * "What I learned" summary: natural-language descriptions of recently
   * learned preferences, derived from the twin profile.
   */
  router.get('/:userId/learned', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const profile = await twinService.getOrCreateProfile(userId);

      // Build human-readable summaries from preferences
      const summaries: { domain: string; description: string }[] = [];

      for (const pref of profile.preferences) {
        const desc = describePreference(pref.domain, pref.key, pref.value);
        if (desc) {
          summaries.push({ domain: pref.domain, description: desc });
        }
      }

      // Also include inferred preferences
      for (const inf of profile.inferences) {
        const desc = describePreference(inf.domain, inf.key, inf.value);
        if (desc) {
          summaries.push({ domain: inf.domain, description: `I noticed: ${desc}` });
        }
      }

      res.json({
        summaries: summaries.slice(0, 10),
        totalPreferences: profile.preferences.length,
        totalInferences: profile.inferences.length,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function describePreference(domain: string, key: string, value: unknown): string | null {
  const domainLabels: Record<string, string> = {
    email: 'Email',
    calendar: 'Calendar',
    finance: 'Finance',
    shopping: 'Shopping',
    travel: 'Travel',
    subscriptions: 'Subscriptions',
  };
  const domainLabel = domainLabels[domain] ?? domain;

  const descriptions: Record<string, Record<string, (v: unknown) => string>> = {
    email: {
      auto_archive_promo: (v) => v ? 'you prefer to archive promotional emails' : 'you want to keep promotional emails in your inbox',
      draft_work_replies: (v) => v ? 'you like having draft replies prepared for work emails' : 'you prefer to write work replies yourself',
    },
    calendar: {
      protect_morning_focus: (v) => v ? 'you like to keep mornings free for focus time' : 'you\'re open to morning meetings',
      auto_accept_recurring: (v) => v ? 'you\'re fine auto-accepting recurring meeting invites' : 'you want to review recurring meetings individually',
    },
    finance: {
      alert_large_charges: (v) => v ? 'you want alerts for charges over $50' : 'you don\'t need large charge alerts',
    },
    shopping: {
      track_price_drops: (v) => v ? 'you want to know about price drops' : 'you\'re not interested in price tracking',
    },
  };

  const domainDescs = descriptions[domain];
  if (domainDescs?.[key]) {
    return domainDescs[key](value);
  }

  // Generic fallback. Goal: produce something a user would write themselves,
  // not a debug dump. Boolean prefs read as "enabled/disabled". Free-form
  // string preferences read as "{Domain}: {their words}". Numeric and
  // structured values include the key for context.
  const humanKey = key.replace(/_/g, ' ');
  if (typeof value === 'boolean') {
    return `${domainLabel}: ${humanKey} is ${value ? 'enabled' : 'disabled'}`;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    // The string IS the preference — surface it directly so it doesn't read
    // like a config file ("find_travel_deals = i love travel deals").
    return `${domainLabel}: ${value.trim()}`;
  }
  if (typeof value === 'number') {
    return `${domainLabel}: ${humanKey} — ${value}`;
  }
  if (value !== null && value !== undefined) {
    // Objects/arrays: render a compact, human-readable summary instead of the
    // useless "[object Object]" that String() produces on a structured value.
    const rendered = renderStructuredPrefValue(value);
    return rendered ? `${domainLabel}: ${humanKey} — ${rendered}` : null;
  }
  return null;
}

/**
 * Turn a structured preference value (array or object) into a short,
 * human-readable string. Never returns "[object Object]".
 */
function renderStructuredPrefValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)))
      .filter((s) => s.length > 0)
      .join(', ');
  }
  if (value !== null && typeof value === 'object') {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      const vs = Array.isArray(v)
        ? v.join(', ')
        : typeof v === 'object'
          ? JSON.stringify(v)
          : String(v);
      if (vs.length > 0) parts.push(`${k.replace(/_/g, ' ')}: ${vs}`);
    }
    return parts.join('; ');
  }
  return String(value);
}
