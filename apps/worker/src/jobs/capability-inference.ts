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

export interface CapabilityInferenceJobDeps {
  registry?: RegistryClient;
  signalLookbackHours?: number;
}

function signalKindFromRow(row: SignalRow): SignalLike['kind'] {
  switch (row.source) {
    case 'gmail':
      return 'email';
    case 'google_calendar':
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
 * TODO: Wire this into the worker's poll loop (e.g. run every 10 cycles, after
 * the existing `pollCount % 10 === 0` block in apps/worker/src/index.ts). Or
 * schedule it via a dedicated cron job once cron infrastructure lands.
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
