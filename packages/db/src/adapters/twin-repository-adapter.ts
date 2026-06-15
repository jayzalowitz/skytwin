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
import {
  encryptColumn,
  readColumn,
  resolveKey,
  type VaultKeyProvider,
} from '../lib/vault-helper.js';

/**
 * #374 — process-wide vault key provider for at-rest column encryption.
 *
 * Null by default: when unset, the preferences read/write paths operate on
 * plaintext columns exactly as before (backward compatible for vault-not-yet-
 * enabled deployments and unit tests). The API/worker calls
 * `setPreferenceVaultKeyProvider(keyCache)` at composition time once the
 * credential vault is enabled; the master key derives from the existing
 * credential-vault passphrase mechanism (OS-keychain integration: #401).
 */
let vaultKeyProvider: VaultKeyProvider | null = null;

/** Wire the per-user key provider (e.g. the credential-vault KeyCache). */
export function setPreferenceVaultKeyProvider(
  provider: VaultKeyProvider | null,
): void {
  vaultKeyProvider = provider;
}

/**
 * Raised when a preference row is stored encrypted but the vault is locked.
 * Surfaced to the API as a 409; the UI prompts the user for their passphrase.
 * NEVER swallowed into a plaintext / ciphertext fallback.
 */
export class VaultLockedError extends Error {
  readonly code = 'vault_locked' as const;
  constructor(message = 'credential vault is locked; unlock to read preferences') {
    super(message);
    this.name = 'VaultLockedError';
  }
}

/**
 * Decode a JSONB column that may be encrypted (#374). `value`/`evidence` are
 * stored either as plaintext JSONB (pre-migration) or AES-256-GCM ciphertext
 * in the `*_encrypted` sibling. Returns the parsed JSON value.
 */
function decodeJsonbColumn(
  encrypted: Buffer | null | undefined,
  plaintext: unknown,
  key: Buffer | null,
  emptyFallback: string,
): unknown {
  // When there is no ciphertext, the plaintext column is already parsed JSONB
  // returned by node-postgres — pass it through untouched.
  if (!encrypted || encrypted.length === 0) {
    return plaintext ?? JSON.parse(emptyFallback);
  }
  const result = readColumn(encrypted, null, key, emptyFallback);
  if (!result.success) {
    if (result.error === 'vault_locked') throw new VaultLockedError();
    throw new Error(`preferences: failed to decrypt column (${result.error})`);
  }
  return JSON.parse(result.value);
}

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

/**
 * @param key - the per-user vault key, or null when the vault is locked /
 *   the feature is off. A null key + an encrypted row throws VaultLockedError;
 *   a null key + a plaintext row reads the plaintext (backward compat).
 */
function preferenceRowToDomain(row: PreferenceRow, key: Buffer | null): Preference {
  const value = decodeJsonbColumn(row.value_encrypted, row.value, key, 'null');
  const evidence = decodeJsonbColumn(row.evidence_encrypted, row.evidence, key, '[]');
  return {
    id: row.id,
    domain: row.domain,
    key: row.key,
    value,
    confidence: row.confidence as ConfidenceLevel,
    source: row.source as PreferenceSource,
    evidenceIds: (evidence ?? []) as string[],
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
    const key = this.requireKeyForRead(userId);
    const result = await query<PreferenceRow>(
      'SELECT * FROM preferences WHERE user_id = $1 ORDER BY updated_at DESC',
      [userId],
    );
    return result.rows.map((r) => preferenceRowToDomain(r, key));
  }

  async getPreferencesByDomain(userId: string, domain: string): Promise<Preference[]> {
    const key = this.requireKeyForRead(userId);
    const result = await query<PreferenceRow>(
      'SELECT * FROM preferences WHERE user_id = $1 AND domain = $2 ORDER BY updated_at DESC',
      [userId, domain],
    );
    return result.rows.map((r) => preferenceRowToDomain(r, key));
  }

  /**
   * Resolve the per-user vault key for a read. Returns null in plaintext mode
   * (feature off) — preferenceRowToDomain then reads plaintext columns. Throws
   * VaultLockedError when the vault is wired but locked, so a locked read can
   * never silently return ciphertext.
   */
  private requireKeyForRead(userId: string): Buffer | null {
    const state = resolveKey(vaultKeyProvider, userId);
    if (state.mode === 'locked') throw new VaultLockedError();
    return state.mode === 'unlocked' ? state.key : null;
  }

  async upsertPreference(userId: string, preference: Preference): Promise<Preference> {
    const state = resolveKey(vaultKeyProvider, userId);
    if (state.mode === 'locked') throw new VaultLockedError();
    const key = state.mode === 'unlocked' ? state.key : null;

    const valueJson = JSON.stringify(preference.value);
    const evidenceJson = JSON.stringify(preference.evidenceIds);

    // Check if a preference with this domain+key already exists for the user
    const existing = await query<PreferenceRow>(
      'SELECT * FROM preferences WHERE user_id = $1 AND domain = $2 AND key = $3 LIMIT 1',
      [userId, preference.domain, preference.key],
    );

    let result;
    if (existing.rows.length > 0) {
      const row = existing.rows[0]!;
      if (key !== null) {
        // Encrypted write: store ciphertext, NULL the plaintext columns.
        result = await query<PreferenceRow>(
          `UPDATE preferences
             SET value = NULL, evidence = NULL,
                 value_encrypted = $1, evidence_encrypted = $2,
                 confidence = $3, source = $4,
                 version = version + 1, updated_at = now()
           WHERE id = $5 RETURNING *`,
          [
            encryptColumn(valueJson, key),
            encryptColumn(evidenceJson, key),
            preference.confidence,
            preference.source,
            row.id,
          ],
        );
      } else {
        // Plaintext write (vault feature off). Also clears any stale ciphertext.
        result = await query<PreferenceRow>(
          `UPDATE preferences
             SET value = $1, confidence = $2, source = $3, evidence = $4,
                 value_encrypted = NULL, evidence_encrypted = NULL,
                 version = version + 1, updated_at = now()
           WHERE id = $5 RETURNING *`,
          [valueJson, preference.confidence, preference.source, evidenceJson, row.id],
        );
      }
    } else if (key !== null) {
      result = await query<PreferenceRow>(
        `INSERT INTO preferences
           (user_id, domain, key, value, evidence,
            value_encrypted, evidence_encrypted, confidence, source, version)
         VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, $7, 1) RETURNING *`,
        [
          userId,
          preference.domain,
          preference.key,
          encryptColumn(valueJson, key),
          encryptColumn(evidenceJson, key),
          preference.confidence,
          preference.source,
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
          valueJson,
          preference.confidence,
          preference.source,
          evidenceJson,
        ],
      );
    }
    return preferenceRowToDomain(result.rows[0]!, key);
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
