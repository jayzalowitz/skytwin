/**
 * CockroachDB exposes INT through PostgreSQL's int8 wire type. The `pg`
 * driver intentionally returns int8 values as strings, so repository results
 * must normalize them before they cross the database boundary.
 */
export function databaseSafeInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^-?\d+$/u.test(value) ? Number(value) : Number.NaN);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Database field ${field} is not a safe integer`);
  }
  return parsed;
}

export function databaseNullableSafeInteger(
  value: unknown,
  field: string,
): number | null {
  return value === null ? null : databaseSafeInteger(value, field);
}
