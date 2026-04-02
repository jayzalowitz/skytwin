import { Router } from 'express';
import { TwinService } from '@skytwin/twin-model';
import { TwinRepositoryAdapter, PatternRepositoryAdapter, feedbackRepository } from '@skytwin/db';

/**
 * Normalize confidence from either a string label or a numeric 0–1 score.
 */
function normalizeConfidence(confidence: unknown): string {
  if (typeof confidence === 'string') return confidence.toLowerCase();
  if (typeof confidence === 'number') {
    if (confidence >= 0.9) return 'confirmed';
    if (confidence >= 0.7) return 'high';
    if (confidence >= 0.4) return 'moderate';
    if (confidence >= 0.2) return 'low';
    return 'speculative';
  }
  return 'speculative';
}

/**
 * Create the evals router for monitoring decision quality and twin learning.
 */
export function createEvalsRouter(): Router {
  const router = Router();
  const twinService = new TwinService(new TwinRepositoryAdapter(), new PatternRepositoryAdapter());

  /**
   * GET /api/evals/:userId/accuracy
   *
   * Calculate real accuracy from feedback data.
   */
  router.get('/:userId/accuracy', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const limit = parseInt(req.query['limit'] as string ?? '100', 10);

      const feedback = await feedbackRepository.findByUser(userId, { limit });
      const total = feedback.length;
      const approved = feedback.filter((f) => f.type === 'approve' || f.type === 'reward').length;
      const rejected = feedback.filter((f) => f.type === 'reject' || f.type === 'punish').length;
      const corrected = feedback.filter((f) => f.type === 'edit' || f.type === 'undo' || f.type === 'restate_preference').length;
      const accuracyRate = total > 0 ? approved / total : 0;

      res.json({
        userId,
        totalDecisions: total,
        approved,
        rejected,
        corrected,
        accuracyRate: Math.round(accuracyRate * 100) / 100,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/evals/:userId/learning
   *
   * Get the twin's learning progress — preferences, inferences, patterns, traits.
   */
  router.get('/:userId/learning', async (req, res, next) => {
    try {
      const { userId } = req.params;

      const [profile, patterns, traits, temporalProfile] = await Promise.all([
        twinService.getOrCreateProfile(userId),
        twinService.getPatterns(userId),
        twinService.getTraits(userId),
        twinService.getTemporalProfile(userId),
      ]);

      // Group preferences and inferences by domain
      const domainStats = new Map<string, { preferences: number; inferences: number; confidence: string }>();
      for (const pref of profile.preferences) {
        const existing = domainStats.get(pref.domain) ?? { preferences: 0, inferences: 0, confidence: 'low' };
        existing.preferences++;
        domainStats.set(pref.domain, existing);
      }
      for (const inf of profile.inferences) {
        const existing = domainStats.get(inf.domain) ?? { preferences: 0, inferences: 0, confidence: 'low' };
        existing.inferences++;
        existing.confidence = inf.confidence;
        domainStats.set(inf.domain, existing);
      }

      res.json({
        userId,
        version: profile.version,
        totalPreferences: profile.preferences.length,
        totalInferences: profile.inferences.length,
        totalPatterns: patterns.length,
        totalTraits: traits.length,
        domains: Object.fromEntries(domainStats),
        activeHours: temporalProfile.activeHours,
        traits: traits.map((t) => ({
          name: t.traitName,
          confidence: t.confidence,
          domains: t.supportingDomains,
          description: t.description,
        })),
        patterns: patterns.slice(0, 10).map((p) => ({
          type: p.patternType,
          action: p.observedAction,
          frequency: p.frequency,
          confidence: p.confidence,
          description: p.description,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/evals/:userId/confidence
   *
   * Get per-domain confidence scores.
   */
  router.get('/:userId/confidence', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const profile = await twinService.getOrCreateProfile(userId);

      const domainConfidence = new Map<string, { total: number; confirmed: number; high: number; moderate: number; low: number; speculative: number }>();

      for (const inf of profile.inferences) {
        const stats = domainConfidence.get(inf.domain) ?? { total: 0, confirmed: 0, high: 0, moderate: 0, low: 0, speculative: 0 };
        stats.total++;
        const level = normalizeConfidence(inf.confidence);
        if (level === 'confirmed') stats.confirmed++;
        else if (level === 'high') stats.high++;
        else if (level === 'moderate') stats.moderate++;
        else if (level === 'low') stats.low++;
        else stats.speculative++;
        domainConfidence.set(inf.domain, stats);
      }

      // Calculate overall confidence per domain (weighted score)
      const domains: Record<string, number> = {};
      for (const [domain, stats] of domainConfidence) {
        const weighted = (stats.confirmed * 4 + stats.high * 3 + stats.moderate * 2 + stats.low * 1) /
          (stats.total * 4) * 100;
        domains[domain] = Math.round(weighted);
      }

      // Overall confidence
      const allInferences = profile.inferences.length;
      const totalWeighted = profile.inferences.reduce((sum, inf) => {
        const weights: Record<string, number> = { confirmed: 4, high: 3, moderate: 2, low: 1, speculative: 0 };
        return sum + (weights[normalizeConfidence(inf.confidence)] ?? 0);
      }, 0);
      const overallConfidence = allInferences > 0 ? Math.round((totalWeighted / (allInferences * 4)) * 100) : 0;

      res.json({
        userId,
        overallConfidence,
        domains,
        totalInferences: allInferences,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
