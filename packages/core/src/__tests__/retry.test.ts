import { describe, it, expect, vi } from 'vitest';
import {
  withRetry,
  RetryableHttpError,
  parseRetryAfter,
  calculateDelay,
} from '../retry.js';

describe('parseRetryAfter', () => {
  it('returns null for null input', () => {
    expect(parseRetryAfter(null)).toBeNull();
  });

  it('parses integer seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000);
  });

  it('parses zero seconds', () => {
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('returns null for non-parseable value', () => {
    expect(parseRetryAfter('not-a-number-or-date')).toBeNull();
  });
});

describe('calculateDelay', () => {
  const config = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    retryableStatuses: [429, 500, 502, 503],
  };

  it('uses retryAfterMs when provided', () => {
    const delay = calculateDelay(0, config, 5000);
    expect(delay).toBe(5000);
  });

  it('caps retryAfterMs at maxDelayMs', () => {
    const delay = calculateDelay(0, config, 60000);
    expect(delay).toBe(30000);
  });

  it('applies exponential backoff without retryAfterMs', () => {
    const delay0 = calculateDelay(0, config, null);
    const delay2 = calculateDelay(2, config, null);
    // attempt 0: baseDelay * 2^0 + jitter = ~1000-1500
    expect(delay0).toBeGreaterThanOrEqual(1000);
    expect(delay0).toBeLessThanOrEqual(1500);
    // attempt 2: baseDelay * 2^2 + jitter = ~4000-4500
    expect(delay2).toBeGreaterThanOrEqual(4000);
    expect(delay2).toBeLessThanOrEqual(4500);
  });

  it('caps delay at maxDelayMs', () => {
    const delay = calculateDelay(20, config, null);
    expect(delay).toBe(30000);
  });
});

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on RetryableHttpError', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new RetryableHttpError(503, 'Service unavailable', null))
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on network errors', async () => {
    const networkErr = new Error('fetch failed');
    const fn = vi.fn()
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry on non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Not found'));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 10 }),
    ).rejects.toThrow('Not found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(
      new RetryableHttpError(503, 'Still down', null),
    );

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 10 }),
    ).rejects.toThrow('Still down');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('respects retryAfterMs from RetryableHttpError', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new RetryableHttpError(429, 'Rate limited', 50))
      .mockResolvedValue('ok');

    const start = Date.now();
    await withRetry(fn, { maxRetries: 1, baseDelayMs: 10 });
    const elapsed = Date.now() - start;

    // Should have waited at least 50ms (the retryAfterMs)
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow small timing variance
  });
});
