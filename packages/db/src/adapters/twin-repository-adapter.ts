import type {
  TwinProfile,
  Preference,
  Inference,
  TwinEvidence,
  FeedbackEvent,
  ConfidenceLevel,
  PreferenceSource,
} from '@skytwin/shared-types';
import type { TwinRepositoryPort } from '@skytwin/twin-model';
import { twinRepository } from '../repositories/twin-repository.js';
import { feedbackRepository } from '../repositories/feedback-repository.js';
import { query } from '../connection.js';
import type { TwinProfileRow, PreferenceRow, FeedbackEventRow } from '../types.js';

function profileRowToDomain(row: TwinProfileRow): TwinProfile {
  return {
    id: row.id,
    userId: row.user_id,
    version: row.version,
    preferences: (row.preferences ?? []) as unknown as Preference[],
    inferences: (row.inferences ?? []) as unknown as Inference[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function preferenceRowToDomain(row: PreferenceRow): Preference {
  return {
    id: row.id,
    domain: row.domain,
    key: row.key,
    value: row.value,
    confidence: row.confidence as ConfidenceLevel,
    source: row.source as PreferenceSource,
    evidenceIds: (row.evidence ?? []) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function feedbackRowToDomain(row: FeedbackEventRow): FeedbackEvent {
  const data = row.data ?? {};
  return {
    id: row.id,
    userId: row.user_id,
    decisionId: row.decision_id,
    feedbackType: row.type as FeedbackEvent['feedbackType'],
    correctedAction: data['correctedAction'] as string | undefined,
    correctedValue: data['correctedValue'],
    reason: data['reason'] as string | undefined,
    timestamp: row.created_at,
  };
}

/**
 * Adapter bridging TwinRepositoryPort to the concrete twinRepository,
 * feedbackRepository, and the preferences table.
 */
export class TwinRepositoryAdapter implements TwinRepositoryPort {
  async getProfile(userId: string): Promise<TwinProfile | null> {
    const row = await twinRepository.getProfile(userId);
    return row ? profileRowToDomain(row) : null;
  }

  async createProfile(profile: TwinProfile): Promise<TwinProfile> {
    const row = await twinRepository.createProfile(profile.userId, {
      preferences: profile.preferences as unknown as unknown[],
      inferences: profile.inferences as unknown as unknown[],
    });
    return profileRowToDomain(row);
  }

  async updateProfile(profile: TwinProfile): Promise<TwinProfile> {
    const row = await twinRepository.updateProfile(
      profile.userId,
      {
        preferences: profile.preferences as unknown as unknown[],
        inferences: profile.inferences as unknown as unknown[],
      },
      `twin-service update to version ${profile.version}`,
    );
    if (!row) {
      // Profile doesn't exist yet; create it
      return this.createProfile(profile);
    }
    return profileRowToDomain(row);
  }

  async getPreferences(userId: string): Promise<Preference[]> {
    const result = await query<PreferenceRow>(
      'SELECT * FROM preferences WHERE user_id = $1 ORDER BY updated_at DESC',
      [userId],
    );
    return result.rows.map(preferenceRowToDomain);
  }

  async getPreferencesByDomain(userId: string, domain: string): Promise<Preference[]> {
    const result = await query<PreferenceRow>(
      'SELECT * FROM preferences WHERE user_id = $1 AND domain = $2 ORDER BY updated_at DESC',
      [userId, domain],
    );
    return result.rows.map(preferenceRowToDomain);
  }

  async upsertPreference(userId: string, preference: Preference): Promise<Preference> {
    // Check if a preference with this domain+key already exists for the user
    const existing = await query<PreferenceRow>(
      'SELECT * FROM preferences WHERE user_id = $1 AND domain = $2 AND key = $3 LIMIT 1',
      [userId, preference.domain, preference.key],
    );

    let result;
    if (existing.rows.length > 0) {
      const row = existing.rows[0]!;
      result = await query<PreferenceRow>(
        `UPDATE preferences SET value = $1, confidence = $2, source = $3, evidence = $4,
         version = version + 1, updated_at = now()
         WHERE id = $5 RETURNING *`,
        [
          JSON.stringify(preference.value),
          preference.confidence,
          preference.source,
          JSON.stringify(preference.evidenceIds),
          row.id,
        ],
      );
    } else {
      result = await query<PreferenceRow>(
        `INSERT INTO preferences (user_id, domain, key, value, confidence, source, evidence, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1) RETURNING *`,
        [
          userId,
          preference.domain,
          preference.key,
          JSON.stringify(preference.value),
          preference.confidence,
          preference.source,
          JSON.stringify(preference.evidenceIds),
        ],
      );
    }
    return preferenceRowToDomain(result.rows[0]!);
  }

  async getInferences(userId: string): Promise<Inference[]> {
    const profile = await twinRepository.getProfile(userId);
    if (!profile) return [];
    return (profile.inferences ?? []) as unknown as Inference[];
  }

  async upsertInference(userId: string, inference: Inference): Promise<Inference> {
    const profile = await twinRepository.getProfile(userId);
    if (!profile) return inference;

    const inferences = (profile.inferences ?? []) as unknown as Inference[];
    const existingIdx = inferences.findIndex((i) => i.id === inference.id);
    if (existingIdx >= 0) {
      inferences[existingIdx] = inference;
    } else {
      inferences.push(inference);
    }

    await twinRepository.updateProfile(userId, {
      inferences: inferences as unknown as unknown[],
    });

    return inference;
  }

  async addEvidence(evidence: TwinEvidence): Promise<TwinEvidence> {
    // Store evidence as a feedback event with type='evidence'
    await feedbackRepository.create({
      userId: evidence.userId,
      decisionId: evidence.id,
      type: 'evidence',
      data: {
        source: evidence.source,
        evidenceType: evidence.type,
        domain: evidence.domain,
        payload: evidence.data,
        timestamp: evidence.timestamp.toISOString(),
      },
    });
    return evidence;
  }

  async getEvidence(userId: string, limit?: number): Promise<TwinEvidence[]> {
    const rows = await feedbackRepository.findByUser(userId, { limit: limit ?? 50 });
    return rows
      .filter((r) => r.type === 'evidence')
      .map((r) => ({
        id: r.decision_id,
        userId: r.user_id,
        source: (r.data['source'] as string) ?? 'unknown',
        type: (r.data['evidenceType'] as string) ?? 'unknown',
        data: (r.data['payload'] as Record<string, unknown>) ?? {},
        domain: (r.data['domain'] as string) ?? 'unknown',
        timestamp: r.data['timestamp'] ? new Date(r.data['timestamp'] as string) : r.created_at,
      }));
  }

  async getEvidenceByIds(ids: string[]): Promise<TwinEvidence[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const result = await query<FeedbackEventRow>(
      `SELECT * FROM feedback_events WHERE decision_id IN (${placeholders}) AND type = 'evidence'`,
      ids,
    );
    return result.rows.map((r) => ({
      id: r.decision_id,
      userId: r.user_id,
      source: (r.data['source'] as string) ?? 'unknown',
      type: (r.data['evidenceType'] as string) ?? 'unknown',
      data: (r.data['payload'] as Record<string, unknown>) ?? {},
      domain: (r.data['domain'] as string) ?? 'unknown',
      timestamp: r.data['timestamp'] ? new Date(r.data['timestamp'] as string) : r.created_at,
    }));
  }

  async addFeedback(feedback: FeedbackEvent): Promise<FeedbackEvent> {
    const row = await feedbackRepository.create({
      userId: feedback.userId,
      decisionId: feedback.decisionId,
      type: feedback.feedbackType,
      data: {
        correctedAction: feedback.correctedAction,
        correctedValue: feedback.correctedValue,
        reason: feedback.reason,
      },
    });
    return feedbackRowToDomain(row);
  }

  async getFeedback(userId: string, limit?: number): Promise<FeedbackEvent[]> {
    const rows = await feedbackRepository.findByUser(userId, { limit: limit ?? 50 });
    return rows
      .filter((r) => r.type !== 'evidence')
      .map(feedbackRowToDomain);
  }
}
