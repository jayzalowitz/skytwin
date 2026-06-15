import { Router } from 'express';
import {
  aiProviderRepository,
  lifebookRepository,
  mempalaceRepository,
} from '@skytwin/db';
import { LlmClient } from '@skytwin/llm-client';
import type { ProviderEntry } from '@skytwin/llm-client';
import type { AIProviderName } from '@skytwin/shared-types';
import type { LifebookImportance } from '@skytwin/db';
import { runPrompt } from '@skytwin/policy-prompts';
import { createLogger } from '@skytwin/core';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import { bindUserIdParamValidator } from '../middleware/validate-uuid.js';

const log = createLogger('api:lifebooks');

/**
 * #319 generic fallback layout — the shape returned when the LLM is
 * unavailable, the wing is sparse, the prompt errors, or any other
 * non-happy path. Same shape is declared in THREE places that MUST
 * stay in sync (Copilot caught the duplication risk):
 *
 *   1. Here (server route fallback).
 *   2. `packages/policy-prompts/prompts/lifebook-layout/v1.md` —
 *      `deterministic_fallback` field in frontmatter; serialised as
 *      a JSON string because that's the field's contract.
 *   3. `apps/web/public/js/pages/lifebook.js` — `GENERIC_LAYOUT`
 *      const, used when the layout fetch itself fails (so the page
 *      still has a renderable default offline).
 *
 * If you change the section ordering or titles here, update the
 * other two. Tests in `lifebook-layout-route.test.ts` pin the
 * server-side shape; the browser-side ships behind an integration
 * test in the dashboard suite.
 */
const GENERIC_LAYOUT = {
  layoutId: 'generic-two-column',
  sections: [
    { type: 'signals' as const, title: 'Recent Signals', order: 0 },
    {
      type: 'capabilities' as const,
      title: 'Suggested Capabilities',
      order: 1,
    },
  ],
};

/**
 * Routes for the Emergent Lifebooks surface (#193 Child 1).
 *
 *   GET    /api/lifebooks/:userId                              — list visible lifebooks
 *   POST   /api/lifebooks/:userId                              — add a domain manually (#193 AC#8)
 *   GET    /api/lifebooks/:userId/all                          — list all (including hidden)
 *   GET    /api/lifebooks/:userId/:domainName                  — single lifebook + wing summary
 *   GET    /api/lifebooks/:userId/:domainName/layout           — adaptive layout (#319)
 *   POST   /api/lifebooks/:userId/:domainName/hide             — hide from dashboards
 *   POST   /api/lifebooks/:userId/:domainName/unhide           — restore visibility
 *   POST   /api/lifebooks/:userId/:domainName/importance       — set override (#321)
 *   DELETE /api/lifebooks/:userId/:domainName/importance       — clear override (#321)
 *
 * The weekly extractor is the primary writer of lifebook *content*; this
 * router adjusts visibility + user-set importance overrides AND supports
 * one user-driven creation path (#193 AC#8: "track 'Volunteering'") that
 * seeds a wing immediately and informs the next extraction run.
 */
export function createLifebooksRouter(): Router {
  const router = Router();
  bindUserIdParamValidator(router);
  bindUserIdParamOwnership(router);

  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }
      const rows = await lifebookRepository.listVisible(userId);
      res.json({ lifebooks: rows.map(rowToJson) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * #193 AC#8: POST /:userId — add a domain manually ("track
   * 'Volunteering'"). Creates the MemPalace wing immediately and seeds a
   * lifebook row stamped `manuallyAdded`. Re-adding an existing domain
   * re-surfaces it (clears hidden_at) rather than erroring.
   *
   * Body: { domainName: string, importance?: 'core'|'secondary'|'emerging' }
   *   - `domainName` required, non-empty after trim, length-capped.
   *   - `importance` optional; defaults to 'emerging' (no signal history
   *     yet). Only applied on first create — re-adds don't demote.
   *
   * 201 on create, 200 on re-surface. 400 on invalid input.
   */
  router.post('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }
      const body = req.body as { domainName?: unknown; importance?: unknown } | undefined;
      const rawName = body?.domainName;
      if (typeof rawName !== 'string' || rawName.trim().length === 0) {
        res.status(400).json({ error: 'domainName must be a non-empty string' });
        return;
      }
      // Cap to a sane wing-name length so a manual add can't write an
      // oversized name into memory_wings.
      if (rawName.trim().length > 120) {
        res.status(400).json({ error: 'domainName must be 120 characters or fewer' });
        return;
      }
      let importance: LifebookImportance | undefined;
      if (body?.importance !== undefined) {
        if (
          body.importance !== 'core' &&
          body.importance !== 'secondary' &&
          body.importance !== 'emerging'
        ) {
          res.status(400).json({
            error: "importance must be one of 'core' | 'secondary' | 'emerging'",
          });
          return;
        }
        importance = body.importance;
      }

      const result = await lifebookRepository.addManual({
        userId,
        domainName: rawName,
        importance,
      });
      if (!result.success) {
        // Repo-level guard mirrors the route guard; reachable only if the
        // name was whitespace that survived the typeof check above.
        res.status(400).json({ error: 'domainName must be a non-empty string' });
        return;
      }
      res.status(result.created ? 201 : 200).json({
        lifebook: rowToJson(result.lifebook),
        created: result.created,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:userId/all', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId parameter' });
        return;
      }
      const rows = await lifebookRepository.listAll(userId);
      res.json({ lifebooks: rows.map(rowToJson) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:userId/:domainName', async (req, res, next) => {
    try {
      const { userId, domainName } = req.params;
      if (!userId || !domainName) {
        res.status(400).json({ error: 'Missing userId or domainName' });
        return;
      }
      const row = await lifebookRepository.findByDomain(userId, decodeURIComponent(domainName));
      if (!row) {
        res.status(404).json({ error: 'Lifebook not found' });
        return;
      }
      let wingSummary: { roomCount: number; drawerCount: number } | null = null;
      if (row.wing_id !== null) {
        const rooms = await mempalaceRepository.getRooms(row.wing_id);
        const drawers = await mempalaceRepository.getDrawers(userId, {
          wingId: row.wing_id,
          limit: 1,
        });
        wingSummary = { roomCount: rooms.length, drawerCount: drawers.length };
      }
      res.json({ lifebook: rowToJson(row), wingSummary });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:userId/:domainName/hide', async (req, res, next) => {
    try {
      const { userId, domainName } = req.params;
      if (!userId || !domainName) {
        res.status(400).json({ error: 'Missing userId or domainName' });
        return;
      }
      const updated = await lifebookRepository.hide(userId, decodeURIComponent(domainName));
      res.json({ updated });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:userId/:domainName/unhide', async (req, res, next) => {
    try {
      const { userId, domainName } = req.params;
      if (!userId || !domainName) {
        res.status(400).json({ error: 'Missing userId or domainName' });
        return;
      }
      const updated = await lifebookRepository.unhide(userId, decodeURIComponent(domainName));
      res.json({ updated });
    } catch (err) {
      next(err);
    }
  });

  /**
   * #321: POST /:userId/:domainName/importance — set a user override.
   * Body: { value: 'core'|'secondary'|'emerging', decayDays?: number }
   * The override wins over the extractor's automatic pick for the
   * decayDays window (default 90; 0 = never auto-decay).
   *
   * 404 when the lifebook doesn't exist; 400 on invalid value.
   */
  router.post('/:userId/:domainName/importance', async (req, res, next) => {
    try {
      const { userId, domainName } = req.params;
      if (!userId || !domainName) {
        res.status(400).json({ error: 'Missing userId or domainName' });
        return;
      }
      const body = req.body as { value?: unknown; decayDays?: unknown } | undefined;
      if (
        body?.value !== 'core' &&
        body?.value !== 'secondary' &&
        body?.value !== 'emerging'
      ) {
        res.status(400).json({
          error: "value must be one of 'core' | 'secondary' | 'emerging'",
        });
        return;
      }
      const decayDays =
        typeof body.decayDays === 'number' && Number.isFinite(body.decayDays) && body.decayDays >= 0
          ? Math.floor(body.decayDays)
          : 90;
      const updated = await lifebookRepository.setImportanceOverride(
        userId,
        decodeURIComponent(domainName),
        body.value,
        decayDays,
      );
      if (!updated) {
        res.status(404).json({ error: 'Lifebook not found' });
        return;
      }
      res.json({ lifebook: rowToJson(updated) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * #319: GET /:userId/:domainName/layout
   *
   * Adaptive per-Lifebook layout. Computes a signal-type histogram from
   * the wing's drawers, runs the `lifebook-layout` prompt to pick a
   * section ordering tuned to the domain's actual data shape, and
   * returns the layout JSON. The browser uses this to render the
   * detail page with sections in the right order (e.g. timeline-first
   * for Health, decisions-first for projects).
   *
   * Response: `{ layout, source, histogram }` where `source` is the
   * complete enum:
   *   - `'llm'` — prompt ran and returned a layout
   *   - `'no_signals'` — wing has 0 drawers; LLM skipped
   *   - `'sparse_fallback'` — < 5 drawers OR < 3 distinct types;
   *     LLM skipped to save token spend (the prompt's own constraint
   *     says to return generic in this case)
   *   - `'no_llm_configured'` — user has no AI providers enabled
   *   - `'provider_lookup_failed'` — `getEnabledForUser` threw
   *     (transient DB / network error); distinct from
   *     `no_llm_configured` so the UI doesn't lie about the cause
   *   - `'deterministic_fallback'` — `runPrompt` invoked but fell
   *     back to its deterministic shape (no provider could complete)
   *   - `'prompt_error'` — `runPrompt` threw; fail-soft response
   * The browser also synthesizes `'fetch_error'` locally when the
   * HTTP request itself fails — that value is never sent by this
   * endpoint.
   *
   * 404 when the lifebook doesn't exist. Layout is computed per
   * request; if this gets hot, future cache: `layouts` table keyed
   * on (user_id, domain_name, signal_count_bucket) with N-hour TTL.
   */
  router.get('/:userId/:domainName/layout', async (req, res, next) => {
    try {
      const { userId, domainName } = req.params;
      if (!userId || !domainName) {
        res.status(400).json({ error: 'Missing userId or domainName' });
        return;
      }
      // Express already URL-decodes req.params, so don't call
      // decodeURIComponent again — that would double-decode and
      // corrupt domain names containing literal '%' characters
      // (e.g. `%25` → `%` from Express, then garbage from a second
      // decode). Copilot caught this on the second-pass review.
      // The other routes in this file (hide / unhide / importance)
      // ALSO double-decode today; that's a pre-existing bug worth
      // a separate sweep and is intentionally NOT touched here.
      const lifebook = await lifebookRepository.findByDomain(userId, domainName);
      if (!lifebook) {
        res.status(404).json({ error: 'Lifebook not found' });
        return;
      }

      // Compute the signal-type histogram from the wing's drawers.
      // Cap at 200 drawers to bound query cost — the histogram is
      // about distribution, not precise totals.
      const histogram: Record<string, number> = {};
      let totalDrawers = 0;
      if (lifebook.wing_id) {
        const drawers = await mempalaceRepository.getDrawers(userId, {
          wingId: lifebook.wing_id,
          limit: 200,
        });
        totalDrawers = drawers.length;
        for (const drawer of drawers) {
          const key = drawer.source_type || 'unknown';
          histogram[key] = (histogram[key] ?? 0) + 1;
        }
      }
      const distinctTypes = Object.keys(histogram).length;

      // Sparse: skip the LLM entirely — the prompt's own constraint
      // says to return generic in this case, and not invoking it
      // saves the token spend.
      if (totalDrawers < 5 || distinctTypes < 3) {
        res.json({
          layout: GENERIC_LAYOUT,
          source: totalDrawers === 0 ? 'no_signals' : 'sparse_fallback',
          histogram,
        });
        return;
      }

      // Build an LlmClient from the user's enabled providers.
      // Distinguish "no providers configured" (legitimate
      // `no_llm_configured`) from "provider lookup failed" (transient
      // error — different source so users + ops don't see a misleading
      // "you have no AI provider" hint when the real issue is a DB
      // blip). Copilot caught the previous collapse-both-to-one-source.
      let llmClient: LlmClient | null = null;
      let providerLookupFailed = false;
      try {
        const rows = await aiProviderRepository.getEnabledForUser(userId);
        if (rows.length > 0) {
          const providers: ProviderEntry[] = rows.map(
            (r: { provider: string; api_key: string; model: string; base_url: string | null }) => ({
              name: r.provider as AIProviderName,
              apiKey: r.api_key,
              model: r.model,
              baseUrl: r.base_url ?? undefined,
            }),
          );
          llmClient = new LlmClient(providers, userId);
        }
      } catch (err) {
        providerLookupFailed = true;
        log.warn('failed to build LlmClient for layout prompt', {
          userId,
          domainName,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (!llmClient) {
        res.json({
          layout: GENERIC_LAYOUT,
          source: providerLookupFailed ? 'provider_lookup_failed' : 'no_llm_configured',
          histogram,
        });
        return;
      }

      try {
        const result = await runPrompt<{
          layoutId: string;
          sections: Array<{ type: string; title: string; order: number }>;
        }>({
          promptName: 'lifebook-layout',
          inputs: {
            lifebook: JSON.stringify({
              domainName: lifebook.domain_name,
              importance: lifebook.importance,
              sample_signals: lifebook.sample_signals,
              suggested_capabilities: lifebook.suggested_capabilities,
            }),
            signal_histogram: JSON.stringify(histogram),
          },
          user: { userId },
          llmClient,
        });

        if (result.fellBackToDeterministic) {
          res.json({ layout: GENERIC_LAYOUT, source: 'deterministic_fallback', histogram });
          return;
        }
        res.json({ layout: result.output, source: 'llm', histogram });
      } catch (err) {
        log.warn('lifebook-layout prompt failed', {
          userId,
          domainName,
          error: err instanceof Error ? err.message : String(err),
        });
        res.json({ layout: GENERIC_LAYOUT, source: 'prompt_error', histogram });
      }
    } catch (err) {
      next(err);
    }
  });

  /**
   * #321: DELETE /:userId/:domainName/importance — clear the override.
   * The `importance` column stays at its current value; the next
   * extractor run sets it back to whatever the prompt picks.
   * Idempotent.
   */
  router.delete('/:userId/:domainName/importance', async (req, res, next) => {
    try {
      const { userId, domainName } = req.params;
      if (!userId || !domainName) {
        res.status(400).json({ error: 'Missing userId or domainName' });
        return;
      }
      const updated = await lifebookRepository.clearImportanceOverride(
        userId,
        decodeURIComponent(domainName),
      );
      if (!updated) {
        res.status(404).json({ error: 'Lifebook not found' });
        return;
      }
      res.json({ lifebook: rowToJson(updated) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

interface LifebookJson {
  id: string;
  domainName: string;
  importance: 'core' | 'secondary' | 'emerging';
  sampleSignals: string[];
  suggestedCapabilities: string[];
  wingId: string | null;
  detectedAt: string;
  lastSeenAt: string;
  hidden: boolean;
  /**
   * #321: surfaced for UI rendering so the detail page / dashboard card
   * can show "set by you" instead of "auto-detected" and offer a
   * Clear button. `null` when no user override exists.
   */
  importanceOverride: {
    value: 'core' | 'secondary' | 'emerging';
    setAt: string;
    decayDays: number;
  } | null;
  /**
   * #193 AC#8: true when the user added this domain manually rather than
   * the extractor detecting it. UI labels it "added by you".
   */
  manuallyAdded: boolean;
}

/**
 * Same freshness check as `lifebookRepository.upsert`'s CASE: an
 * override counts as "currently honored" only if `decayDays === 0`
 * (never auto-decay) OR `setAt + decayDays` is in the future.
 *
 * Without this check `rowToJson` would surface stale overrides that
 * the extractor no longer respects, and the UI would label such
 * lifebooks as "set by you" while the importance had already
 * decayed back to the extractor's pick. (Copilot caught it.)
 */
function isOverrideFresh(
  override: { setAt: string; decayDays: number },
  now: Date = new Date(),
): boolean {
  if (override.decayDays === 0) return true;
  const setAt = new Date(override.setAt);
  if (Number.isNaN(setAt.getTime())) return false;
  const deadlineMs = setAt.getTime() + override.decayDays * 24 * 60 * 60 * 1000;
  return now.getTime() < deadlineMs;
}

function rowToJson(r: import('@skytwin/db').LifebookRow): LifebookJson {
  const override = r.metadata?.importanceOverride;
  const fresh = override && isOverrideFresh(override);
  return {
    id: r.id,
    domainName: r.domain_name,
    importance: r.importance,
    sampleSignals: r.sample_signals,
    suggestedCapabilities: r.suggested_capabilities,
    wingId: r.wing_id,
    detectedAt: r.detected_at.toISOString(),
    lastSeenAt: r.last_seen_at.toISOString(),
    hidden: r.hidden_at !== null,
    importanceOverride: fresh
      ? {
          value: override.value,
          setAt: override.setAt,
          decayDays: override.decayDays,
        }
      : null,
    manuallyAdded: r.metadata?.manuallyAdded === true,
  };
}
