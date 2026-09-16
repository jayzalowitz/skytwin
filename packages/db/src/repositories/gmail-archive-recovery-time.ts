export function exactTimestampEpochMicroseconds(value: string | Date): bigint | null {
  const epochMilliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(epochMilliseconds)) return null;
  const subMilliseconds = typeof value === 'string'
    ? /\.\d{3}(\d{3})?Z$/.exec(value)?.[1] ?? '0'
    : '0';
  return BigInt(epochMilliseconds) * 1_000n + BigInt(subMilliseconds);
}
