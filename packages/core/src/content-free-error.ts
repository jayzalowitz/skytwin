/** Bounded operational classifications safe for durable logs and metrics. */
export type OperationalFailureCode =
  | 'authentication_failed'
  | 'network_unavailable'
  | 'operation_failed'
  | 'rate_limited'
  | 'timeout'
  | 'upstream_unavailable';

function safeField(error: unknown, field: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    return Reflect.get(error, field);
  } catch {
    return undefined;
  }
}

/**
 * Classify an arbitrary throwable without reading or serializing its message,
 * stack, response body, or other provider-controlled content.
 */
export function classifyOperationalFailure(error: unknown): OperationalFailureCode {
  const status = safeField(error, 'statusCode') ?? safeField(error, 'status');
  if (status === 401 || status === 403) return 'authentication_failed';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (typeof status === 'number' && status >= 500 && status <= 599) {
    return 'upstream_unavailable';
  }

  const code = safeField(error, 'code');
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH' || code === 'EAI_AGAIN') return 'network_unavailable';

  const name = safeField(error, 'name');
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  return 'operation_failed';
}

export function operationalFailureMeta(error: unknown): { errorCode: OperationalFailureCode } {
  return { errorCode: classifyOperationalFailure(error) };
}
