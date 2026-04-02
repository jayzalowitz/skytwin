import { describe, it, expect, beforeEach } from 'vitest';
import { ConfidenceLevel } from '@skytwin/shared-types';
import type { Preference } from '@skytwin/shared-types';
import {
  PreferenceEvolutionTracker,
  type PreferenceHistoryRepositoryPort,
  type PreferenceHistoryEntry,
  type PreferenceHistoryInput,
} from '../preference-evolution.js';

function makePreference(overrides: Partial<Preference> = {}): Preference {
  return {
    id: 'pref_1',
    domain: 'email',
    key: 'auto_archive',
    value: true,
    confidence: ConfidenceLevel.MODERATE,
    source: 'inferred',
    evidenceIds: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

class InMemoryPreferenceHistoryRepo implements PreferenceHistoryRepositoryPort {
  private entries: PreferenceHistoryEntry[] = [];
  private nextId = 1;

  async create(input: PreferenceHistoryInput): Promise<PreferenceHistoryEntry> {
    const entry: PreferenceHistoryEntry = {
      id: `phist_${this.nextId++}`,
      preferenceId: input.preferenceId,
      userId: input.userId,
      previousValue: input.previousValue,
      newValue: input.newValue,
      previousConfidence: input.previousConfidence,
      newConfidence: input.newConfidence,
      attributionType: input.attributionType,
      attributionId: input.attributionId ?? null,
      changedAt: new Date(),
    };
    this.entries.push(entry);
    return entry;
  }

  async getForPreference(preferenceId: string, limit = 50): Promise<PreferenceHistoryEntry[]> {
    return this.entries
      .filter((e) => e.preferenceId === preferenceId)
      .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime())
      .slice(0, limit);
  }

  async getForUser(userId: string, limit = 100): Promise<PreferenceHistoryEntry[]> {
    return this.entries
      .filter((e) => e.userId === userId)
      .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime())
      .slice(0, limit);
  }

  async getByAttribution(
    attributionType: string,
    attributionId: string,
  ): Promise<PreferenceHistoryEntry[]> {
    return this.entries
      .filter(
        (e) => e.attributionType === attributionType && e.attributionId === attributionId,
      )
      .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime());
  }

  async getAtPointInTime(
    userId: string,
    pointInTime: Date,
  ): Promise<PreferenceHistoryEntry[]> {
    const byPref = new Map<string, PreferenceHistoryEntry>();
    for (const entry of this.entries) {
      if (entry.userId !== userId || entry.changedAt.getTime() > pointInTime.getTime()) continue;
      const existing = byPref.get(entry.preferenceId);
      if (!existing || entry.changedAt.getTime() > existing.changedAt.getTime()) {
        byPref.set(entry.preferenceId, entry);
      }
    }
    return Array.from(byPref.values());
  }

  // Test helper: set changedAt on the last created entry
  setLastChangedAt(date: Date): void {
    if (this.entries.length > 0) {
      this.entries[this.entries.length - 1]!.changedAt = date;
    }
  }
}

describe('PreferenceEvolutionTracker', () => {
  let repo: InMemoryPreferenceHistoryRepo;
  let tracker: PreferenceEvolutionTracker;

  beforeEach(() => {
    repo = new InMemoryPreferenceHistoryRepo();
    tracker = new PreferenceEvolutionTracker(repo);
  });

  it('records a preference change', async () => {
    const prev = makePreference({ value: false, confidence: ConfidenceLevel.LOW });
    const next = makePreference({ value: true, confidence: ConfidenceLevel.MODERATE });

    const entry = await tracker.recordChange('user1', prev, next, 'feedback', 'fb_1');

    expect(entry).not.toBeNull();
    expect(entry!.previousValue).toBe(false);
    expect(entry!.newValue).toBe(true);
    expect(entry!.previousConfidence).toBe(ConfidenceLevel.LOW);
    expect(entry!.newConfidence).toBe(ConfidenceLevel.MODERATE);
    expect(entry!.attributionType).toBe('feedback');
    expect(entry!.attributionId).toBe('fb_1');
  });

  it('records new preference (null previous)', async () => {
    const next = makePreference();
    const entry = await tracker.recordChange('user1', null, next, 'explicit');

    expect(entry!.previousValue).toBeNull();
    expect(entry!.previousConfidence).toBeNull();
  });

  it('returns full history for a preference', async () => {
    const pref = makePreference();

    await tracker.recordChange('user1', null, pref, 'explicit');
    const updated = makePreference({ value: false, confidence: ConfidenceLevel.HIGH });
    await tracker.recordChange('user1', pref, updated, 'feedback', 'fb_1');

    const history = await tracker.getHistory('pref_1');
    expect(history).toHaveLength(2);
  });

  it('finds changes by attribution', async () => {
    const pref = makePreference();
    await tracker.recordChange('user1', null, pref, 'feedback', 'fb_99');

    const changes = await tracker.getChangesFromAttribution('feedback', 'fb_99');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.attributionId).toBe('fb_99');
  });

  it('summarizes preference evolution', async () => {
    const p1 = makePreference({ value: true, confidence: ConfidenceLevel.LOW });
    const p2 = makePreference({ value: false, confidence: ConfidenceLevel.MODERATE });
    const p3 = makePreference({ value: false, confidence: ConfidenceLevel.HIGH });

    await tracker.recordChange('user1', null, p1, 'explicit');
    repo.setLastChangedAt(new Date('2026-01-01'));

    await tracker.recordChange('user1', p1, p2, 'feedback', 'fb_1');
    repo.setLastChangedAt(new Date('2026-02-01'));

    await tracker.recordChange('user1', p2, p3, 'evidence', 'ev_1');
    repo.setLastChangedAt(new Date('2026-03-01'));

    const summary = await tracker.summarize('pref_1');
    expect(summary).not.toBeNull();
    expect(summary!.totalChanges).toBe(3);
    expect(summary!.valueChanges).toBe(2); // null->true, true->false
    expect(summary!.confidenceChanges).toBe(3); // null->LOW, LOW->MODERATE, MODERATE->HIGH
    expect(summary!.attributionBreakdown).toEqual({
      explicit: 1,
      feedback: 1,
      evidence: 1,
    });
    expect(summary!.firstSeen).toEqual(new Date('2026-01-01'));
    expect(summary!.lastChanged).toEqual(new Date('2026-03-01'));
  });

  it('gets preference state at a point in time', async () => {
    const p1 = makePreference({ value: 'alpha', confidence: ConfidenceLevel.LOW });
    const p2 = makePreference({ value: 'beta', confidence: ConfidenceLevel.HIGH });

    await tracker.recordChange('user1', null, p1, 'explicit');
    repo.setLastChangedAt(new Date('2026-01-15'));

    await tracker.recordChange('user1', p1, p2, 'feedback', 'fb_1');
    repo.setLastChangedAt(new Date('2026-03-15'));

    // Query at Feb 1 — should get 'alpha'
    const stateAtFeb = await tracker.getStateAt('pref_1', new Date('2026-02-01'));
    expect(stateAtFeb).not.toBeNull();
    expect(stateAtFeb!.value).toBe('alpha');
    expect(stateAtFeb!.confidence).toBe(ConfidenceLevel.LOW);

    // Query at Apr 1 — should get 'beta'
    const stateAtApr = await tracker.getStateAt('pref_1', new Date('2026-04-01'));
    expect(stateAtApr).not.toBeNull();
    expect(stateAtApr!.value).toBe('beta');
    expect(stateAtApr!.confidence).toBe(ConfidenceLevel.HIGH);
  });

  it('returns null/empty when no repository configured', async () => {
    const noRepoTracker = new PreferenceEvolutionTracker(null);
    const pref = makePreference();

    expect(await noRepoTracker.recordChange('u1', null, pref, 'explicit')).toBeNull();
    expect(await noRepoTracker.getHistory('pref_1')).toEqual([]);
    expect(await noRepoTracker.getUserHistory('u1')).toEqual([]);
    expect(await noRepoTracker.summarize('pref_1')).toBeNull();
    expect(await noRepoTracker.getStateAt('pref_1', new Date())).toBeNull();
  });
});
