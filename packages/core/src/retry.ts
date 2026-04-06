/**
 * Retry utility with exponential backoff and jitter.
 *
 * Supports Retry-After header parsing for HTTP 429 responses.
 */

export interface RetryConfig {
  /** Maximum number of retry attempts. Default: 3 */
  maxRetries: number;
  /** Base delay in milliseconds before first retry. Default: 1000 */
  baseDelayMs: number;
  /** Maximum delay in milliseconds. Default: 30000 */
  maxDelayMs: number;
  /** HTTP status codes that should trigger a retry. Default: [429, 500, 502, 503] */
  retryableStatuses: number[];
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableStatuses: [429, 500, 502, 503],
};

/**
 * Error thrown when a fetch response has a retryable status code.
 * Carries the response so callers can inspect Retry-After headers.
 */
export class RetryableHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, message: string, retryAfterMs: number | null) {
    super(message);
    this.name = 'RetryableHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parse Retry-After header value.
 * Supports both seconds (integer) and HTTP-date formats.
 * Returns delay in milliseconds, or null if not present/parseable.
 */
export function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;

  // Try as seconds (integer)
  const seconds = parseInt(headerValue, 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  // Try as HTTP-date
  const date = new Date(headerValue);
  if (!isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    return delayMs > 0 ? delayMs : 0;
  }

  return null;
}

/**
 * Calculate delay for a given attempt using exponential backoff with jitter.
 */
export function calculateDelay(attempt: number, config: RetryConfig, retryAfterMs: number | null): number {
  if (retryAfterMs !== null && retryAfterMs > 0) {
    return Math.min(retryAfterMs, config.maxDelayMs);
  }

  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * config.baseDelayMs * 0.5;
  return Math.min(exponentialDelay + jitter, config.maxDelayMs);
}

/**
 * Execute an async function with exponential backoff retry.
 *
 * The function should throw a RetryableHttpError for HTTP errors
 * that should be retried, or any Error for unexpected failures.
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => fetchWithRetryCheck('https://api.example.com/data'),
 *   { maxRetries: 3 }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
): Promise<T> {
  const fullConfig: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= fullConfig.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt >= fullConfig.maxRetries) {
        break;
      }

      // Only retry on RetryableHttpError or network errors
      if (error instanceof RetryableHttpError) {
        const delay = calculateDelay(attempt, fullConfig, error.retryAfterMs);
        await sleep(delay);
        continue;
      }

      // Retry on generic network errors (fetch failures, timeouts)
      if (isNetworkError(error)) {
        const delay = calculateDelay(attempt, fullConfig, null);
        await sleep(delay);
        continue;
      }

      // Non-retryable error — throw immediately
      throw error;
    }
  }

  throw lastError ?? new Error('withRetry: all attempts exhausted');
}

/**
 * Wrapper around fetch that throws RetryableHttpError for retryable status codes.
 * Use this with withRetry() for automatic retry on transient HTTP errors.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  retryableStatuses: number[] = DEFAULT_RETRY_CONFIG.retryableStatuses,
): Promise<Response> {
  const response = await fetch(url, init);

  if (!response.ok && retryableStatuses.includes(response.status)) {
    const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
    throw new RetryableHttpError(
      response.status,
      `HTTP ${response.status} from ${url}`,
      retryAfterMs,
    );
  }

  return response;
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  if (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('dns') ||
    error.name === 'AbortError'
  ) {
    return true;
  }
  // Node fetch throws TypeError for network failures, but only when the message
  // indicates a fetch/request issue (not a programming TypeError like null dereference)
  if (error.name === 'TypeError' && (msg.includes('fetch') || msg.includes('request') || msg.includes('url'))) {
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
