import { describe, it, expect, afterEach } from 'vitest';
import {
  capabilityInferenceEnabled,
  shouldRunCapabilityInference,
  CAPABILITY_INFERENCE_INTERVAL_MS,
} from '../jobs/capability-inference.js';

const FLAG = 'SKYTWIN_CAPABILITY_INFERENCE_ENABLED';

describe('capabilityInferenceEnabled()', () => {
  const original = process.env[FLAG];
  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it('is OFF by default (env unset) — never runs autonomously without opt-in', () => {
    delete process.env[FLAG];
    expect(capabilityInferenceEnabled()).toBe(false);
  });

  it('is ON only for the exact string "true"', () => {
    process.env[FLAG] = 'true';
    expect(capabilityInferenceEnabled()).toBe(true);
  });

  it.each(['false', 'TRUE', '1', 'yes', '', 'on'])(
    'treats %j as OFF (fail-closed on anything but "true")',
    (val) => {
      process.env[FLAG] = val;
      expect(capabilityInferenceEnabled()).toBe(false);
    },
  );
});

describe('shouldRunCapabilityInference()', () => {
  const interval = CAPABILITY_INFERENCE_INTERVAL_MS;

  it('never runs when disabled, even if the interval has long elapsed', () => {
    expect(
      shouldRunCapabilityInference({ enabled: false, nowMs: 10 * interval, lastRunAt: 0 }),
    ).toBe(false);
  });

  it('runs on first tick when enabled (lastRunAt = 0)', () => {
    expect(
      shouldRunCapabilityInference({ enabled: true, nowMs: interval, lastRunAt: 0 }),
    ).toBe(true);
  });

  it('does not run again before the interval elapses', () => {
    const lastRunAt = 1_000_000;
    expect(
      shouldRunCapabilityInference({
        enabled: true,
        nowMs: lastRunAt + interval - 1,
        lastRunAt,
      }),
    ).toBe(false);
  });

  it('runs exactly at the interval boundary (>=)', () => {
    const lastRunAt = 1_000_000;
    expect(
      shouldRunCapabilityInference({ enabled: true, nowMs: lastRunAt + interval, lastRunAt }),
    ).toBe(true);
  });

  it('honors an injected interval override', () => {
    expect(
      shouldRunCapabilityInference({ enabled: true, nowMs: 500, lastRunAt: 0, intervalMs: 1000 }),
    ).toBe(false);
    expect(
      shouldRunCapabilityInference({ enabled: true, nowMs: 1000, lastRunAt: 0, intervalMs: 1000 }),
    ).toBe(true);
  });
});
