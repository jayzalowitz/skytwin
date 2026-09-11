import type { WorkerDeadLetterErrorCode } from '@skytwin/db';

/**
 * Reduce an arbitrary failure to the bounded operational vocabulary accepted by
 * the worker DLQ. Throwable text is never returned because it can contain source
 * content, credentials, remote response bodies, or other user data.
 */
export function classifyWorkerFailure(error: unknown): WorkerDeadLetterErrorCode {
  const record = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : {};
  const code = typeof record['code'] === 'string' ? record['code'] : '';
  const status = typeof record['status'] === 'number'
    ? record['status']
    : typeof record['statusCode'] === 'number'
      ? record['statusCode']
      : null;

  if (code === 'vault_locked') return 'vault_locked';
  if (code === 'vault_broker_unavailable') return 'broker_unavailable';
  if (
    code === 'timeout' ||
    code === 'ETIMEDOUT' ||
    record['name'] === 'TimeoutError' ||
    status === 408 ||
    status === 504
  ) return 'timeout';
  if (code.startsWith('08') || code === '57P01') return 'database_unavailable';
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENETUNREACH' ||
    code === 'EAI_AGAIN' ||
    (status !== null && status >= 500)
  ) return 'network_unavailable';
  if (status === 429 || code === 'rate_limited') return 'rate_limited';
  if (code === 'configuration_invalid') return 'configuration_invalid';
  return 'job_failed';
}
