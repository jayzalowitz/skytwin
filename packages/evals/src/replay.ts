// Twin state reconstruction from versioned snapshots and preference history.

/**
 * Port interface for retrieving twin profile versions.
 */
export interface TwinVersionRepositoryPort {
  getVersionAt(userId: string, pointInTime: Date): Promise<TwinProfileSnapshot | null>;
  getVersionHistory(userId: string, limit?: number): Promise<TwinProfileSnapshot[]>;
}

/**
 * Port interface for retrieving preference history.
 */
export interface PreferenceHistoryReplayPort {
  getAtPointInTime(userId: string, pointInTime: Date): Promise<PreferenceSnapshot[]>;
}

export interface TwinProfileSnapshot {
  id: string;
  profileId: string;
  version: number;
  snapshot: Record<string, unknown>;
  changedFields: string[];
  reason: string | null;
  createdAt: Date;
}

export interface PreferenceSnapshot {
  id: string;
  preferenceId: string;
  userId: string;
  previousValue: unknown;
  newValue: unknown;
  previousConfidence: string | null;
  newConfidence: string;
  attributionType: string;
  attributionId: string | null;
  changedAt: Date;
}

export interface ReplayResult {
  userId: string;
  pointInTime: Date;
  twinVersion: number | null;
  preferences: Array<{ id: string; value: unknown; confidence: string }>;
  snapshotFound: boolean;
}

/**
 * Reconstructs twin state at a point in time using twin_profile_versions
 * and preference_history.
 */
export class TemporalReplayEngine {
  constructor(
    private readonly twinVersionRepo: TwinVersionRepositoryPort,
    private readonly preferenceHistoryRepo: PreferenceHistoryReplayPort,
  ) {}

  /**
   * Reconstruct the twin's state at a specific point in time.
   */
  async replayAt(userId: string, pointInTime: Date): Promise<ReplayResult> {
    // Get twin profile version at that time
    const versionSnapshot = await this.twinVersionRepo.getVersionAt(userId, pointInTime);

    // Get preference states at that time
    const preferenceSnapshots = await this.preferenceHistoryRepo.getAtPointInTime(
      userId,
      pointInTime,
    );

    const preferences = preferenceSnapshots.map((ps) => ({
      id: ps.preferenceId,
      value: ps.newValue,
      confidence: ps.newConfidence,
    }));

    return {
      userId,
      pointInTime,
      twinVersion: versionSnapshot?.version ?? null,
      preferences,
      snapshotFound: versionSnapshot !== null,
    };
  }

  /**
   * Compare twin state between two points in time.
   */
  async diffBetween(
    userId: string,
    from: Date,
    to: Date,
  ): Promise<ReplayDiff> {
    const [stateFrom, stateTo] = await Promise.all([
      this.replayAt(userId, from),
      this.replayAt(userId, to),
    ]);

    const fromMap = new Map(stateFrom.preferences.map((p) => [p.id, p]));
    const toMap = new Map(stateTo.preferences.map((p) => [p.id, p]));

    const added: Array<{ id: string; value: unknown; confidence: string }> = [];
    const removed: Array<{ id: string; value: unknown; confidence: string }> = [];
    const changed: Array<{
      id: string;
      fromValue: unknown;
      toValue: unknown;
      fromConfidence: string;
      toConfidence: string;
    }> = [];

    for (const [id, pref] of toMap) {
      const fromPref = fromMap.get(id);
      if (!fromPref) {
        added.push(pref);
      } else if (
        JSON.stringify(fromPref.value) !== JSON.stringify(pref.value) ||
        fromPref.confidence !== pref.confidence
      ) {
        changed.push({
          id,
          fromValue: fromPref.value,
          toValue: pref.value,
          fromConfidence: fromPref.confidence,
          toConfidence: pref.confidence,
        });
      }
    }

    for (const [id, pref] of fromMap) {
      if (!toMap.has(id)) {
        removed.push(pref);
      }
    }

    return {
      userId,
      from,
      to,
      versionFrom: stateFrom.twinVersion,
      versionTo: stateTo.twinVersion,
      added,
      removed,
      changed,
    };
  }

  /**
   * Get the full version timeline for a user.
   */
  async getTimeline(userId: string, limit?: number): Promise<TwinProfileSnapshot[]> {
    return this.twinVersionRepo.getVersionHistory(userId, limit);
  }
}

export interface ReplayDiff {
  userId: string;
  from: Date;
  to: Date;
  versionFrom: number | null;
  versionTo: number | null;
  added: Array<{ id: string; value: unknown; confidence: string }>;
  removed: Array<{ id: string; value: unknown; confidence: string }>;
  changed: Array<{
    id: string;
    fromValue: unknown;
    toValue: unknown;
    fromConfidence: string;
    toConfidence: string;
  }>;
}
