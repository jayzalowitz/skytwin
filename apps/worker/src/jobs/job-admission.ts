/**
 * Guard a worker job at an await boundary. Database writes have an additional
 * transactional generation fence in @skytwin/db and HTTP requests inherit the
 * process-wide generation signal; this helper prevents local work from
 * starting or continuing once that process generation is revoked.
 */
export function requireJobAdmission(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export async function runAdmitted<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  requireJobAdmission(signal);
  const result = await operation();
  requireJobAdmission(signal);
  return result;
}
