/**
 * Runtime validation for /api/events/ingest payloads.
 *
 * Hand-rolled rather than reaching for Zod — the API only has a handful of
 * boundary endpoints today and adding a runtime dep for one of them would be
 * premature. The shape here matches what `SituationInterpreter.interpret()`
 * actually reads, so a payload that passes validation will not crash the
 * downstream pipeline with a TypeError.
 */

const VALID_URGENCIES = new Set(['low', 'medium', 'high', 'critical']);
// User ids in this codebase are PostgreSQL uuids (gen_random_uuid()).
// Reject anything that is not the canonical 8-4-4-4-12 hex-with-dashes form
// here at the boundary so the DB layer doesn't crash with a 500 on every
// typo'd test client or stale session token.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Discriminated result type. Errors are field-keyed so the API can echo
 *  them back to the caller without leaking internal structure. */
export type EventIngestValidationResult =
  | { ok: true; event: Record<string, unknown>; userId: string }
  | { ok: false; errors: Array<{ field: string; message: string }> };

export function validateEventIngest(raw: unknown): EventIngestValidationResult {
  const errors: Array<{ field: string; message: string }> = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: '_body', message: 'Request body must be a JSON object' }] };
  }

  const event = raw as Record<string, unknown>;
  const userId = event['userId'];

  if (typeof userId !== 'string' || userId.trim().length === 0) {
    errors.push({ field: 'userId', message: 'userId is required and must be a non-empty string' });
  } else if (!UUID_REGEX.test(userId)) {
    errors.push({ field: 'userId', message: 'userId must be a valid UUID' });
  }

  // Source and type are not strictly required (the interpreter falls back),
  // but if present they must be strings — otherwise downstream code crashes
  // on `.toLowerCase()` against a non-string.
  if ('source' in event && event['source'] !== undefined && typeof event['source'] !== 'string') {
    errors.push({ field: 'source', message: 'source must be a string when provided' });
  }
  if ('type' in event && event['type'] !== undefined && typeof event['type'] !== 'string') {
    errors.push({ field: 'type', message: 'type must be a string when provided' });
  }

  // Urgency is read directly into the DecisionObject. Accept only the four
  // documented values plus undefined.
  if (event['urgency'] !== undefined) {
    if (typeof event['urgency'] !== 'string' || !VALID_URGENCIES.has(event['urgency'])) {
      errors.push({
        field: 'urgency',
        message: 'urgency must be one of: low, medium, high, critical',
      });
    }
  }

  // `data` is optional but must be a plain object when provided.
  if (event['data'] !== undefined) {
    if (event['data'] === null || typeof event['data'] !== 'object' || Array.isArray(event['data'])) {
      errors.push({ field: 'data', message: 'data must be a JSON object when provided' });
    }
  }

  // Trust tier MUST NOT come from the caller — the API reads it from the DB.
  // Reject payloads that try to inject one to make the contract explicit.
  if ('trustTier' in event) {
    errors.push({
      field: 'trustTier',
      message: 'trustTier cannot be set by the caller; it is sourced from the user record',
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, event, userId: userId as string };
}
