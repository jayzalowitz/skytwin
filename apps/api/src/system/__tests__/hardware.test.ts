import { describe, it, expect } from 'vitest';
import { recommendLocalModel, type HardwareProfile } from '../hardware.js';

/** Build a HardwareProfile with sane defaults, overridable per test. */
function hw(overrides: Partial<HardwareProfile>): HardwareProfile {
  return {
    ramGB: 16,
    freeDiskGB: 100,
    cpuCores: 8,
    arch: 'arm64',
    platform: 'darwin',
    hasLlamaBinary: true,
    ramBracket: '16gb',
    ...overrides,
  };
}

describe('recommendLocalModel', () => {
  it('picks the highest-quality model that fits both RAM and disk', () => {
    // 32GB RAM + plenty of disk → the top 32gb-plus model.
    const rec = recommendLocalModel(hw({ ramGB: 32, freeDiskGB: 200, ramBracket: '32gb-plus' }));
    expect(rec.model).not.toBeNull();
    expect(rec.model?.ramBracket).toBe('32gb-plus');
    expect(rec.fitsDisk).toBe(true);
    expect(rec.downloadGB).toBeGreaterThan(0);
    expect(rec.reason).toMatch(/Best model for your computer/i);
  });

  it('steps down to a smaller model when disk is tight but RAM is ample', () => {
    // 32GB RAM (would allow the 9GB model) but only 8GB free → must step down.
    const rec = recommendLocalModel(hw({ ramGB: 32, freeDiskGB: 8, ramBracket: '32gb-plus' }));
    expect(rec.model).not.toBeNull();
    // 9GB model + 3GB headroom = 12GB > 8GB free, so it cannot be the pick.
    expect((rec.model?.approxBytes ?? 0) / (1024 ** 3) + 3).toBeLessThanOrEqual(8);
    expect(rec.fitsDisk).toBe(true);
    expect(rec.reason).toMatch(/fit your free disk|wouldn't fit/i);
  });

  it('never recommends a model that needs more RAM than the machine has', () => {
    const rec = recommendLocalModel(hw({ ramGB: 4, freeDiskGB: 100, ramBracket: '4gb' }));
    expect(rec.model?.ramBracket).toBe('4gb');
  });

  it('returns no model with a clear reason when disk is too small for anything', () => {
    const rec = recommendLocalModel(hw({ ramGB: 16, freeDiskGB: 2, ramBracket: '16gb' }));
    expect(rec.model).toBeNull();
    expect(rec.fitsDisk).toBe(false);
    expect(rec.downloadGB).toBeNull();
    expect(rec.reason).toMatch(/Not enough free disk|cloud API key/i);
  });

  it('treats unknown free disk (null) as "assume it fits" rather than blocking', () => {
    const rec = recommendLocalModel(hw({ ramGB: 32, freeDiskGB: null, ramBracket: '32gb-plus' }));
    expect(rec.model).not.toBeNull();
    expect(rec.fitsDisk).toBe(true);
  });

  it('always includes the machine profile it decided from', () => {
    const profile = hw({ ramGB: 8, ramBracket: '8gb' });
    const rec = recommendLocalModel(profile);
    expect(rec.hardware.ramGB).toBe(8);
    expect(rec.hardware.ramBracket).toBe('8gb');
  });
});
