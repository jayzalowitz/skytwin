import { describe, it, expect, beforeEach } from 'vitest';
import {
  TemporalReplayEngine,
  type TwinVersionRepositoryPort,
  type PreferenceHistoryReplayPort,
  type TwinProfileSnapshot,
  type PreferenceSnapshot,
} from '../replay.js';

class InMemoryTwinVersionRepo implements TwinVersionRepositoryPort {
  private versions: TwinProfileSnapshot[] = [];

  addVersion(v: TwinProfileSnapshot): void {
    this.versions.push(v);
  }

  async getVersionAt(_userId: string, pointInTime: Date): Promise<TwinProfileSnapshot | null> {
    const matching = this.versions
      .filter((v) => v.createdAt.getTime() <= pointInTime.getTime())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return matching[0] ?? null;
  }

  async getVersionHistory(_userId: string, limit = 50): Promise<TwinProfileSnapshot[]> {
    return this.versions
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}

class InMemoryPreferenceHistoryReplayRepo implements PreferenceHistoryReplayPort {
  private entries: PreferenceSnapshot[] = [];

  addEntry(e: PreferenceSnapshot): void {
    this.entries.push(e);
  }

  async getAtPointInTime(userId: string, pointInTime: Date): Promise<PreferenceSnapshot[]> {
    const byPref = new Map<string, PreferenceSnapshot>();
    for (const entry of this.entries) {
      if (entry.userId !== userId || entry.changedAt.getTime() > pointInTime.getTime()) continue;
      const existing = byPref.get(entry.preferenceId);
      if (!existing || entry.changedAt.getTime() > existing.changedAt.getTime()) {
        byPref.set(entry.preferenceId, entry);
      }
    }
    return Array.from(byPref.values());
  }
}

function makeSnapshot(version: number, date: Date): TwinProfileSnapshot {
  return {
    id: `v_${version}`,
    profileId: 'twin_user1',
    version,
    snapshot: { version },
    changedFields: ['preferences'],
    reason: null,
    createdAt: date,
  };
}

function makePrefSnapshot(
  prefId: string,
  value: unknown,
  confidence: string,
  date: Date,
): PreferenceSnapshot {
  return {
    id: `phist_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    preferenceId: prefId,
    userId: 'user1',
    previousValue: null,
    newValue: value,
    previousConfidence: null,
    newConfidence: confidence,
    attributionType: 'explicit',
    attributionId: null,
    changedAt: date,
  };
}

describe('TemporalReplayEngine', () => {
  let twinVersionRepo: InMemoryTwinVersionRepo;
  let prefHistoryRepo: InMemoryPreferenceHistoryReplayRepo;
  let engine: TemporalReplayEngine;

  beforeEach(() => {
    twinVersionRepo = new InMemoryTwinVersionRepo();
    prefHistoryRepo = new InMemoryPreferenceHistoryReplayRepo();
    engine = new TemporalReplayEngine(twinVersionRepo, prefHistoryRepo);
  });

  it('replays twin state at a point in time', async () => {
    twinVersionRepo.addVersion(makeSnapshot(1, new Date('2026-01-01')));
    twinVersionRepo.addVersion(makeSnapshot(2, new Date('2026-02-01')));
    twinVersionRepo.addVersion(makeSnapshot(3, new Date('2026-03-01')));

    prefHistoryRepo.addEntry(makePrefSnapshot('p1', 'alpha', 'LOW', new Date('2026-01-15')));
    prefHistoryRepo.addEntry(makePrefSnapshot('p1', 'beta', 'HIGH', new Date('2026-02-15')));
    prefHistoryRepo.addEntry(makePrefSnapshot('p2', 'gamma', 'MODERATE', new Date('2026-02-01')));

    // Replay at Feb 10 — should see version 2, p1=alpha, p2=gamma
    const result = await engine.replayAt('user1', new Date('2026-02-10'));
    expect(result.snapshotFound).toBe(true);
    expect(result.twinVersion).toBe(2);
    expect(result.preferences).toHaveLength(2);
    expect(result.preferences.find((p) => p.id === 'p1')?.value).toBe('alpha');
    expect(result.preferences.find((p) => p.id === 'p2')?.value).toBe('gamma');
  });

  it('returns null version when no snapshot exists before the time', async () => {
    const result = await engine.replayAt('user1', new Date('2025-01-01'));
    expect(result.snapshotFound).toBe(false);
    expect(result.twinVersion).toBeNull();
    expect(result.preferences).toEqual([]);
  });

  it('diffs between two points in time', async () => {
    twinVersionRepo.addVersion(makeSnapshot(1, new Date('2026-01-01')));
    twinVersionRepo.addVersion(makeSnapshot(5, new Date('2026-04-01')));

    // At T1: p1=alpha
    prefHistoryRepo.addEntry(makePrefSnapshot('p1', 'alpha', 'LOW', new Date('2026-01-05')));
    // At T2: p1=beta, p2=gamma (p2 added)
    prefHistoryRepo.addEntry(makePrefSnapshot('p1', 'beta', 'HIGH', new Date('2026-03-01')));
    prefHistoryRepo.addEntry(makePrefSnapshot('p2', 'gamma', 'MODERATE', new Date('2026-03-15')));

    const diff = await engine.diffBetween(
      'user1',
      new Date('2026-02-01'),
      new Date('2026-04-01'),
    );

    expect(diff.versionFrom).toBe(1);
    expect(diff.versionTo).toBe(5);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]!.id).toBe('p2');
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.fromValue).toBe('alpha');
    expect(diff.changed[0]!.toValue).toBe('beta');
    expect(diff.removed).toHaveLength(0);
  });

  it('returns the full version timeline', async () => {
    twinVersionRepo.addVersion(makeSnapshot(1, new Date('2026-01-01')));
    twinVersionRepo.addVersion(makeSnapshot(2, new Date('2026-02-01')));
    twinVersionRepo.addVersion(makeSnapshot(3, new Date('2026-03-01')));

    const timeline = await engine.getTimeline('user1');
    expect(timeline).toHaveLength(3);
    // Ordered newest first
    expect(timeline[0]!.version).toBe(3);
  });
});
