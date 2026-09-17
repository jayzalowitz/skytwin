import { query } from '../connection.js';
import {
  revalidateSourceKeySessionAuthority,
  type SessionAuthorityVerificationResult,
  type SourceKeySessionAuthorityInput,
} from './session-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 64 * 1024;

export interface SourceKeyRegistryRow {
  user_id: string;
  key_version: number;
  wrapper_version: number;
  algorithm: 'aes-256-gcm';
  kdf_record: unknown;
  recovery_wrapper: unknown;
  created_at: Date;
  retired_at: Date | null;
}

interface RawSourceKeyRegistryRow {
  user_id: unknown;
  key_version: unknown;
  wrapper_version: unknown;
  algorithm: unknown;
  kdf_record: unknown;
  recovery_wrapper: unknown;
  created_at: unknown;
  retired_at: unknown;
}

export class SourceKeyRegistryConflictError extends Error {
  override readonly name = 'SourceKeyRegistryConflictError';
}

function positiveInt(value: unknown, field: string): number {
  const normalized = typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(normalized) || (normalized as number) <= 0) {
    throw new SourceKeyRegistryConflictError(`Invalid ${field}`);
  }
  return normalized as number;
}

function canonicalJson(value: unknown, field: string): unknown {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded) > MAX_JSON_BYTES) throw new Error('invalid');
    const decoded: unknown = JSON.parse(encoded);
    if (decoded === null || typeof decoded !== 'object') throw new Error('invalid');
    const pending: object[] = [decoded];
    const seen = new Set<object>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (seen.size > 4_096) throw new Error('too complex');
      for (const child of Object.values(current)) {
        if (child !== null && typeof child === 'object') pending.push(child);
      }
      Object.freeze(current);
    }
    return decoded;
  } catch {
    throw new SourceKeyRegistryConflictError(`Invalid ${field}`);
  }
}

function date(value: unknown, field: string): Date {
  const parsed = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === 'string'
      ? new Date(value)
      : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) {
    throw new SourceKeyRegistryConflictError(`Invalid ${field}`);
  }
  return parsed;
}

function validateUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    throw new SourceKeyRegistryConflictError('Invalid user_id');
  }
}

function snapshotInput(
  input: Omit<SourceKeyRegistryRow, 'created_at' | 'retired_at'>,
): Omit<SourceKeyRegistryRow, 'created_at' | 'retired_at'> {
  validateUserId(input.user_id);
  const keyVersion = positiveInt(input.key_version, 'key_version');
  const wrapperVersion = positiveInt(input.wrapper_version, 'wrapper_version');
  if (keyVersion !== 1 || wrapperVersion !== 1 || input.algorithm !== 'aes-256-gcm') {
    throw new SourceKeyRegistryConflictError('Only the initial wrapper format is supported');
  }
  return Object.freeze({
    user_id: input.user_id,
    key_version: keyVersion,
    wrapper_version: wrapperVersion,
    algorithm: 'aes-256-gcm',
    kdf_record: canonicalJson(input.kdf_record, 'kdf_record'),
    recovery_wrapper: canonicalJson(input.recovery_wrapper, 'recovery_wrapper'),
  });
}

function normalizeRow(raw: RawSourceKeyRegistryRow): SourceKeyRegistryRow {
  validateUserId(raw.user_id);
  const keyVersion = positiveInt(raw.key_version, 'key_version');
  const wrapperVersion = positiveInt(raw.wrapper_version, 'wrapper_version');
  if (keyVersion !== 1 || wrapperVersion !== 1 || raw.algorithm !== 'aes-256-gcm') {
    throw new SourceKeyRegistryConflictError('Unsupported active source-key wrapper');
  }
  if (raw.retired_at !== null) throw new SourceKeyRegistryConflictError('Active row is retired');
  return Object.freeze({
    user_id: raw.user_id,
    key_version: keyVersion,
    wrapper_version: wrapperVersion,
    algorithm: 'aes-256-gcm',
    kdf_record: canonicalJson(raw.kdf_record, 'kdf_record'),
    recovery_wrapper: canonicalJson(raw.recovery_wrapper, 'recovery_wrapper'),
    created_at: date(raw.created_at, 'created_at'),
    retired_at: null,
  });
}

// Deliberately absent from the general DB barrel. Desktop composition reaches
// this sensitive leaf only through the narrow source-key-registry subpath.
export const sourceKeyRegistryRepository = {
  async revalidateSessionAuthority(
    input: SourceKeySessionAuthorityInput,
  ): Promise<SessionAuthorityVerificationResult> {
    return await revalidateSourceKeySessionAuthority(input);
  },
  async getCurrent(userId: string): Promise<SourceKeyRegistryRow | null> {
    validateUserId(userId);
    const result = await query<RawSourceKeyRegistryRow>(
      `SELECT user_id, key_version, wrapper_version, algorithm, kdf_record,
              recovery_wrapper, created_at, retired_at
         FROM user_source_key_registry
        WHERE user_id = $1 AND retired_at IS NULL
        ORDER BY key_version DESC LIMIT 2`,
      [userId],
    );
    if (result.rows.length > 1) {
      throw new SourceKeyRegistryConflictError('Multiple active source-key wrappers');
    }
    return result.rows[0] === undefined ? null : normalizeRow(result.rows[0]);
  },

  async createInitial(input: Omit<SourceKeyRegistryRow, 'created_at' | 'retired_at'>): Promise<boolean> {
    const frozen = snapshotInput(input);
    const result = await query(
      `INSERT INTO user_source_key_registry
        (user_id, key_version, wrapper_version, algorithm, kdf_record, recovery_wrapper)
       SELECT $1, $2, $3, $4, $5::JSONB, $6::JSONB
        WHERE NOT EXISTS (
          SELECT 1 FROM user_source_key_registry WHERE user_id = $1
        )
       ON CONFLICT (user_id, key_version) DO NOTHING
       RETURNING user_id`,
      [
        frozen.user_id,
        frozen.key_version,
        frozen.wrapper_version,
        frozen.algorithm,
        frozen.kdf_record,
        frozen.recovery_wrapper,
      ],
    );
    return result.rowCount === 1;
  },

  async deleteInitialIfMatch(
    input: Omit<SourceKeyRegistryRow, 'created_at' | 'retired_at'>,
  ): Promise<boolean> {
    const frozen = snapshotInput(input);
    const result = await query(
      `DELETE FROM user_source_key_registry
        WHERE user_id = $1
          AND key_version = $2
          AND wrapper_version = $3
          AND algorithm = $4
          AND kdf_record = $5::JSONB
          AND recovery_wrapper = $6::JSONB
          AND retired_at IS NULL
       RETURNING user_id`,
      [
        frozen.user_id,
        frozen.key_version,
        frozen.wrapper_version,
        frozen.algorithm,
        frozen.kdf_record,
        frozen.recovery_wrapper,
      ],
    );
    return result.rowCount === 1;
  },

  async requestDeletion(userId: string): Promise<void> {
    validateUserId(userId);
    await query(
      `UPSERT INTO source_key_deletion_intents (user_id, requested_at, device_wrapper_deleted_at)
       VALUES ($1, now(), NULL)`,
      [userId],
    );
  },
};
