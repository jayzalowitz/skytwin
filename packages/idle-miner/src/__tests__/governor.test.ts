import { describe, it, expect, beforeEach } from 'vitest';
import { ResourceGovernor } from '../governor.js';

describe('ResourceGovernor', () => {
  let nowMs: number;
  let governor: ResourceGovernor;

  beforeEach(() => {
    nowMs = 1_000_000;
    governor = new ResourceGovernor(
      {
        cpuPercentCap: 2,
        cpuWindowMs: 60_000,
        yieldOnInputMs: 200,
        batteryPctCap: 20,
        thermalPauseStates: ['serious', 'critical'],
        ioBudgetBytesPerDay: 1_073_741_824,
        memoryRssCapBytes: 67_108_864,
      },
      { nowMs: () => nowMs, cpuSampleMs: () => 0 },
    );
  });

  it('yields on input event within yieldOnInputMs window', () => {
    governor.reportInputEvent();
    nowMs += 100; // 100ms after input event
    expect(governor.shouldYield()).toBe(true);
  });

  it('does not yield once yieldOnInputMs window has passed', () => {
    governor.reportInputEvent();
    nowMs += 500; // 500ms after input event
    expect(governor.shouldYield()).toBe(false);
  });

  it('yields on thermal state critical', () => {
    governor.reportThermalState('critical');
    expect(governor.shouldYield()).toBe(true);
  });

  it('yields on thermal state serious', () => {
    governor.reportThermalState('serious');
    expect(governor.shouldYield()).toBe(true);
  });

  it('does not yield on nominal thermal state', () => {
    governor.reportThermalState('nominal');
    expect(governor.shouldYield()).toBe(false);
  });

  it('yields on battery below 20% when not charging', () => {
    governor.reportBatteryState(15, false);
    expect(governor.shouldYield()).toBe(true);
  });

  it('does NOT yield on battery below 20% when charging', () => {
    governor.reportBatteryState(15, true);
    expect(governor.shouldYield()).toBe(false);
  });

  it('yields when daily bytes budget is exceeded', () => {
    governor.reportBytesRead(1_073_741_824); // exactly 1 GB
    expect(governor.shouldYield()).toBe(true);
  });

  it('does NOT yield when bytes scanned plus new chunk is within budget', () => {
    governor.reportBytesRead(100_000);
    expect(governor.shouldYield()).toBe(false);
  });

  it('daily bytes budget rolls over at midnight UTC', () => {
    // Simulate midnight: now is 2024-01-01, advance past midnight
    nowMs = new Date('2024-01-01T23:59:59Z').getTime();
    const govRollover = new ResourceGovernor(
      { ioBudgetBytesPerDay: 1_000 },
      { nowMs: () => nowMs, cpuSampleMs: () => 0 },
    );
    govRollover.reportBytesRead(1_000); // hits budget
    expect(govRollover.shouldYield()).toBe(true);
    // Advance to the next day
    nowMs = new Date('2024-01-02T00:00:01Z').getTime();
    // Trigger rollover via shouldYield
    govRollover.reportBytesRead(0);
    expect(govRollover.shouldYield()).toBe(false);
    expect(govRollover.state().bytesScannedToday).toBe(0);
    expect(govRollover.state().rolledOverDate).toBe('2024-01-02');
  });

  it('yields when RSS exceeds memory cap', () => {
    governor.reportRssBytes(67_108_864 + 1); // 64 MB + 1
    expect(governor.shouldYield()).toBe(true);
  });

  it('does not yield when RSS is below memory cap', () => {
    governor.reportRssBytes(50_000_000);
    expect(governor.shouldYield()).toBe(false);
  });

  it('throws at construct time when ioBudgetBytesPerDay > ioBudgetBytesHardCeiling', () => {
    expect(() => {
      new ResourceGovernor({ ioBudgetBytesPerDay: 6_000_000_000 });
    }).toThrow(/exceeds the compile-time hard ceiling/);
  });

  it('state.pauseReason reflects the active cause', () => {
    governor.reportThermalState('critical');
    const s = governor.state();
    expect(s.paused).toBe(true);
    expect(s.pauseReason).toBe('thermal');
  });

  it('shouldYield returns false and pauseReason clears once cause resolves', () => {
    governor.reportThermalState('critical');
    expect(governor.shouldYield()).toBe(true);
    governor.reportThermalState('nominal');
    expect(governor.shouldYield()).toBe(false);
    expect(governor.state().pauseReason).toBeUndefined();
  });
});
