import { createLogger } from '@skytwin/core';
import {
  userRepository,
  signalRepository,
  appSuggestionRepository,
} from '@skytwin/db';
import type { SignalRow } from '@skytwin/db';
import { RegistryClient } from '@skytwin/registry-client';
import { CapabilityInferenceEngine } from '@skytwin/capability-engine';
import type { SignalLike } from '@skytwin/capability-engine';

const log = createLogger('worker:capability-inference');

const SIGNAL_LOOKBACK_HOURS = 7 * 24;
/**
 * Dismissed suggestions are not re-surfaced for this many days.
 * TODO: enforce via a getPendingForUser variant that filters out recently-dismissed rows.
 */
const DISMISSED_COOLDOWN_DAYS = 30;

/**
 * Poll-loop cadence for the capability-inference job. Daily: the job reads a
 * rolling 7-day signal window, so a 24h pass keeps suggestions fresh without
 * re-scanning the same window every cycle.
 */
export const CAPABILITY_INFERENCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Feature flag. Capability inference is OFF unless
 * `SKYTWIN_CAPABILITY_INFERENCE_ENABLED=true`. It reads existing signals and
 * writes advisory `app_suggestions` rows only — no real-account writes, no
 * sends — but stays opt-in so nothing runs autonomously without explicit
 * enablement (mirrors the `SKYTWIN_DRAFTS_ENABLED` opt-in contract).
 */
export function capabilityInferenceEnabled(): boolean {
  return process.env['SKYTWIN_CAPABILITY_INFERENCE_ENABLED'] === 'true';
}

/**
 * Poll-loop scheduling decision: run only when the feature is enabled AND at
 * least one interval has elapsed since the last run. Pure + fully injectable so
 * the gate (the new logic) is unit-tested without driving the worker's infinite
 * poll loop. Mirrors the `nowMs - lastAt >= INTERVAL` shape the other scheduled
 * jobs inline in `apps/worker/src/index.ts`.
 */
export function shouldRunCapabilityInference(input: {
  enabled: boolean;
  nowMs: number;
  lastRunAt: number;
  intervalMs?: number;
}): boolean {
  if (!input.enabled) return false;
  const interval = input.intervalMs ?? CAPABILITY_INFERENCE_INTERVAL_MS;
  return input.nowMs - input.lastRunAt >= interval;
}

export interface CapabilityInferenceJobDeps {
  registry?: RegistryClient;
  signalLookbackHours?: number;
}

function signalKindFromRow(row: SignalRow): SignalLike['kind'] {
  switch (row.source) {
    case 'gmail':
    case 'outlook':
      return 'email';
    case 'google_calendar':
    case 'outlook_calendar':
      return 'calendar';
    case 'fs':
    case 'filesystem':
      return 'fs';
    case 'browser_history':
      return 'browser_history';
    default:
      return 'email';
  }
}

function excerptFromRow(row: SignalRow): string {
  const data = row.data as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof data['subject'] === 'string') parts.push(data['subject']);
  if (typeof data['summary'] === 'string') parts.push(data['summary']);
  if (typeof data['title'] === 'string') parts.push(data['title']);
  if (typeof data['description'] === 'string') parts.push(data['description']);
  const joined = parts.join(' ').slice(0, 200);
  return joined.length > 0 ? joined : (JSON.stringify(data).slice(0, 200));
}

/**
 * For each active user, reads recent signals, runs the capability inference
 * engine, and upserts AppSuggestion rows.
 *
 * Wired into the worker poll loop (`apps/worker/src/index.ts`) on a daily
 * cadence, gated by `capabilityInferenceEnabled()` /
 * `shouldRunCapabilityInference()` — opt-in via
 * `SKYTWIN_CAPABILITY_INFERENCE_ENABLED`, default off.
 *
 * Surfacing rules enforced here (in addition to engine threshold):
 *   - Skip if a `pending` suggestion already exists (upsertPending merges in
 *     place, so calling it is safe — the conflict clause handles the guard).
 *   - Skip dismissed suggestions that were dismissed within the last 30 days.
 *   - Skip snoozed suggestions whose snoozed_until is in the future.
 */
export async function runCapabilityInferenceJob(
  deps: CapabilityInferenceJobDeps = {},
): Promise<void> {
  const registry = deps.registry ?? new RegistryClient({ smitheryEnabled: false });
  const lookbackHours = deps.signalLookbackHours ?? SIGNAL_LOOKBACK_HOURS;

  const engine = new CapabilityInferenceEngine({
    registry,
    surfacingThreshold: { evidenceCount: 3, kindsDistinct: 2 },
  });

  let users: { id: string }[];
  try {
    users = await userRepository.findAll();
  } catch (err) {
    log.error('Failed to load users for capability inference', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  log.info(`Running capability inference for ${users.length} user(s)`);
  let totalSuggestions = 0;
  let totalSkipped = 0;

  for (const user of users) {
    try {
      const rows = await signalRepository.getRecent(user.id, undefined, lookbackHours);

      const signals: SignalLike[] = rows.map((row) => ({
        id: row.id,
        kind: signalKindFromRow(row),
        excerpt: excerptFromRow(row),
        occurredAt: row.timestamp instanceof Date ? row.timestamp : new Date(row.timestamp),
      }));

      const suggestions = await engine.run(user.id, signals);

      const activeRows = await appSuggestionRepository.getActiveForUser(user.id);
      const recentlyDismissed = await appSuggestionRepository.getRecentlyDismissedForUser(
        user.id,
        DISMISSED_COOLDOWN_DAYS,
      );

      const activeByRegistry = new Map(activeRows.map((r) => [r.registry_id, r]));
      const dismissedByRegistry = new Set(recentlyDismissed.map((r) => r.registry_id));

      let userSuggestions = 0;
      let userSkipped = 0;

      for (const suggestion of suggestions) {
        if (dismissedByRegistry.has(suggestion.registryId)) {
          userSkipped++;
          continue;
        }

        const existing = activeByRegistry.get(suggestion.registryId);

        if (existing?.status === 'snoozed') {
          const until = existing.snoozed_until;
          if (until && new Date(until).getTime() > Date.now()) {
            userSkipped++;
            continue;
          }
        }

        await appSuggestionRepository.upsertPending({
          userId: suggestion.userId,
          registryId: suggestion.registryId,
          displayName: suggestion.displayName,
          evidenceCount: suggestion.evidenceCount,
          evidenceSources: suggestion.evidenceSources,
          evidenceKindsDistinct: suggestion.evidenceKindsDistinct,
          firstEvidenceAt: suggestion.firstEvidenceAt,
          lastEvidenceAt: suggestion.lastEvidenceAt,
          confidenceScore: suggestion.confidenceScore,
          reasonSummary: suggestion.reasonSummary,
        });
        userSuggestions++;
      }

      totalSuggestions += userSuggestions;
      totalSkipped += userSkipped;

      if (userSuggestions > 0 || userSkipped > 0) {
        log.info(`User ${user.id}: ${userSuggestions} suggestion(s) upserted, ${userSkipped} skipped`);
      }
    } catch (err) {
      log.error(`Capability inference failed for user ${user.id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info(
    `Capability inference complete: ${totalSuggestions} suggestion(s) upserted, ${totalSkipped} skipped`,
    { users: users.length, totalSuggestions, totalSkipped },
  );

}
