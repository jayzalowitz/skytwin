import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateId,
  createLogger,
  compareRiskTiers,
  riskExceeds,
  trustMeetsOrExceeds,
  RISK_TIER_ORDER,
  TRUST_TIER_ORDER,
  CONFIDENCE_LEVEL_ORDER,
} from '../index.js';

describe('generateId', () => {
  it('returns a UUID-shaped string', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('returns unique values across calls', () => {
    const ids = new Set([generateId(), generateId(), generateId()]);
    expect(ids.size).toBe(3);
  });
});

describe('compareRiskTiers', () => {
  it('returns 0 for equal tiers', () => {
    expect(compareRiskTiers('low', 'low')).toBe(0);
    expect(compareRiskTiers('critical', 'critical')).toBe(0);
  });

  it('returns negative when a < b', () => {
    expect(compareRiskTiers('low', 'high')).toBeLessThan(0);
    expect(compareRiskTiers('negligible', 'critical')).toBeLessThan(0);
  });

  it('returns positive when a > b', () => {
    expect(compareRiskTiers('high', 'low')).toBeGreaterThan(0);
    expect(compareRiskTiers('critical', 'negligible')).toBeGreaterThan(0);
  });

  it('treats unknown tiers as 0 (lowest)', () => {
    expect(compareRiskTiers('unknown', 'negligible')).toBe(0);
    expect(compareRiskTiers('unknown', 'low')).toBeLessThan(0);
  });
});

describe('riskExceeds', () => {
  it('returns true when risk is strictly above threshold', () => {
    expect(riskExceeds('high', 'moderate')).toBe(true);
    expect(riskExceeds('critical', 'low')).toBe(true);
  });

  it('returns false when risk equals threshold', () => {
    expect(riskExceeds('moderate', 'moderate')).toBe(false);
  });

  it('returns false when risk is below threshold', () => {
    expect(riskExceeds('low', 'high')).toBe(false);
  });
});

describe('trustMeetsOrExceeds', () => {
  it('returns true when actual >= required', () => {
    expect(trustMeetsOrExceeds('high_autonomy', 'low_autonomy')).toBe(true);
    expect(trustMeetsOrExceeds('moderate_autonomy', 'moderate_autonomy')).toBe(true);
  });

  it('returns false when actual < required', () => {
    expect(trustMeetsOrExceeds('observer', 'high_autonomy')).toBe(false);
    expect(trustMeetsOrExceeds('suggest', 'moderate_autonomy')).toBe(false);
  });

  it('treats unknown tier as observer (0)', () => {
    expect(trustMeetsOrExceeds('unknown', 'observer')).toBe(true);
    expect(trustMeetsOrExceeds('unknown', 'suggest')).toBe(false);
  });
});

describe('tier ordering tables', () => {
  it('RISK_TIER_ORDER orders from negligible (0) to critical (4)', () => {
    const order = ['negligible', 'low', 'moderate', 'high', 'critical'].map(
      (t) => RISK_TIER_ORDER[t] ?? -1,
    );
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('TRUST_TIER_ORDER orders from observer (0) to high_autonomy (4)', () => {
    expect(TRUST_TIER_ORDER['observer']).toBe(0);
    expect(TRUST_TIER_ORDER['high_autonomy']).toBe(4);
  });

  it('CONFIDENCE_LEVEL_ORDER orders from speculative (0) to confirmed (4)', () => {
    expect(CONFIDENCE_LEVEL_ORDER['speculative']).toBe(0);
    expect(CONFIDENCE_LEVEL_ORDER['confirmed']).toBe(4);
  });
});

describe('createLogger', () => {
  // Using a permissive helper type because vi.spyOn's generic differs across
  // versions and we just need .mockRestore + .mock.calls here.
  type Spy = ReturnType<typeof vi.fn> & { mockRestore: () => void };
  let debugSpy: Spy;
  let infoSpy: Spy;
  let warnSpy: Spy;
  let errorSpy: Spy;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {}) as unknown as Spy;
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {}) as unknown as Spy;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) as unknown as Spy;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) as unknown as Spy;
  });

  afterEach(() => {
    debugSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('routes each level to the matching console method', () => {
    const log = createLogger('test');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(debugSpy).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('includes namespace, level, and message in each formatted line', () => {
    const log = createLogger('decision-engine');
    log.info('Hello');
    const line = String(infoSpy.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('[INFO]');
    expect(line).toContain('[decision-engine]');
    expect(line).toContain('Hello');
  });

  it('serializes meta as JSON when present', () => {
    const log = createLogger('test');
    log.warn('something', { userId: 'u1', count: 3 });
    const line = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('"userId":"u1"');
    expect(line).toContain('"count":3');
  });

  it('omits the meta blob when no meta is supplied', () => {
    const log = createLogger('test');
    log.info('plain');
    const line = String(infoSpy.mock.calls[0]?.[0] ?? '');
    expect(line).not.toContain('{');
  });

  it('emits an ISO 8601 timestamp', () => {
    const log = createLogger('test');
    log.error('boom');
    const line = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(line).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
  });
});
