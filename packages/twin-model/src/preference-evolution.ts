import type { Preference } from '@skytwin/shared-types';

/**
 * Port interface for persisting preference history.
 * Business logic depends on this interface; adapters satisfy it at composition time.
 */
export interface PreferenceHistoryRepositoryPort {
  create(input: PreferenceHistoryInput): Promise<PreferenceHistoryEntry>;
  getForPreference(preferenceId: string, limit?: number): Promise<PreferenceHistoryEntry[]>;
  getForUser(userId: string, limit?: number): Promise<PreferenceHistoryEntry[]>;
  getByAttribution(attributionType: string, attributionId: string): Promise<PreferenceHistoryEntry[]>;
  getAtPointInTime(userId: string, pointInTime: Date): Promise<PreferenceHistoryEntry[]>;
}

export interface PreferenceHistoryInput {
  preferenceId: string;
  userId: string;
  previousValue: unknown;
  newValue: unknown;
  previousConfidence: string | null;
  newConfidence: string;
  attributionType: 'feedback' | 'evidence' | 'explicit' | 'inference';
  attributionId?: string;
}

export interface PreferenceHistoryEntry {
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

export interface EvolutionSummary {
  preferenceId: string;
  totalChanges: number;
  valueChanges: number;
  confidenceChanges: number;
  attributionBreakdown: Record<string, number>;
  firstSeen: Date;
  lastChanged: Date;
}

/**
 * Tracks how preferences evolve over time, with attribution to the
 * feedback or evidence that caused each change.
 */
export class PreferenceEvolutionTracker {
  constructor(
    private readonly repository: PreferenceHistoryRepositoryPort | null = null,
  ) {}

  /**
   * Record a preference change with attribution.
   */
  async recordChange(
    userId: string,
    previousPreference: Preference | null,
    newPreference: Preference,
    attributionType: 'feedback' | 'evidence' | 'explicit' | 'inference',
    attributionId?: string,
  ): Promise<PreferenceHistoryEntry | null> {
    if (!this.repository) return null;

    return this.repository.create({
      preferenceId: newPreference.id,
      userId,
      previousValue: previousPreference?.value ?? null,
      newValue: newPreference.value,
      previousConfidence: previousPreference?.confidence ?? null,
      newConfidence: newPreference.confidence,
      attributionType,
      attributionId,
    });
  }

  /**
   * Get the full change history for a single preference.
   */
  async getHistory(preferenceId: string, limit?: number): Promise<PreferenceHistoryEntry[]> {
    if (!this.repository) return [];
    return this.repository.getForPreference(preferenceId, limit);
  }

  /**
   * Get all preference changes for a user.
   */
  async getUserHistory(userId: string, limit?: number): Promise<PreferenceHistoryEntry[]> {
    if (!this.repository) return [];
    return this.repository.getForUser(userId, limit);
  }

  /**
   * Get changes caused by a specific feedback event or evidence.
   */
  async getChangesFromAttribution(
    attributionType: string,
    attributionId: string,
  ): Promise<PreferenceHistoryEntry[]> {
    if (!this.repository) return [];
    return this.repository.getByAttribution(attributionType, attributionId);
  }

  /**
   * Compute a summary of how a preference has evolved.
   */
  async summarize(preferenceId: string): Promise<EvolutionSummary | null> {
    if (!this.repository) return null;

    const history = await this.repository.getForPreference(preferenceId);
    if (history.length === 0) return null;

    let valueChanges = 0;
    let confidenceChanges = 0;
    const attributionBreakdown: Record<string, number> = {};

    for (const entry of history) {
      if (JSON.stringify(entry.previousValue) !== JSON.stringify(entry.newValue)) {
        valueChanges++;
      }
      if (entry.previousConfidence !== entry.newConfidence) {
        confidenceChanges++;
      }
      attributionBreakdown[entry.attributionType] =
        (attributionBreakdown[entry.attributionType] ?? 0) + 1;
    }

    // History is ordered DESC by changedAt
    const sorted = [...history].sort(
      (a, b) => a.changedAt.getTime() - b.changedAt.getTime(),
    );

    return {
      preferenceId,
      totalChanges: history.length,
      valueChanges,
      confidenceChanges,
      attributionBreakdown,
      firstSeen: sorted[0]!.changedAt,
      lastChanged: sorted[sorted.length - 1]!.changedAt,
    };
  }

  /**
   * Reconstruct the state of a preference at a point in time.
   */
  async getStateAt(
    preferenceId: string,
    pointInTime: Date,
  ): Promise<{ value: unknown; confidence: string } | null> {
    if (!this.repository) return null;

    const history = await this.repository.getForPreference(preferenceId);
    // Find the most recent entry at or before the given time
    const atTime = history
      .filter((e) => e.changedAt.getTime() <= pointInTime.getTime())
      .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime())[0];

    if (!atTime) return null;

    return {
      value: atTime.newValue,
      confidence: atTime.newConfidence,
    };
  }
}
