import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/fake/home'),
}));

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isGbrainInstalled, hasExternalGbrainConfig } from '../cli-detector.js';

const mockExecSync = execSync as ReturnType<typeof vi.fn>;
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;

describe('isGbrainInstalled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when execSync succeeds (gbrain is in PATH)', () => {
    mockExecSync.mockReturnValue(undefined);
    expect(isGbrainInstalled()).toBe(true);
  });

  it('returns false when execSync throws (gbrain not found)', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(isGbrainInstalled()).toBe(false);
  });

  it('returns false when execSync throws with exit code 1 (ENOENT)', () => {
    const err = Object.assign(new Error('Command failed'), { status: 1 });
    mockExecSync.mockImplementation(() => { throw err; });
    expect(isGbrainInstalled()).toBe(false);
  });

  it('returns false on timeout error', () => {
    const err = Object.assign(new Error('spawnSync gbrain ETIMEDOUT'), { code: 'ETIMEDOUT' });
    mockExecSync.mockImplementation(() => { throw err; });
    expect(isGbrainInstalled()).toBe(false);
  });

  it('uses "where gbrain" on Windows', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    mockExecSync.mockReturnValue(undefined);
    isGbrainInstalled();

    expect(mockExecSync).toHaveBeenCalledWith(
      'where gbrain',
      expect.objectContaining({ timeout: 3000 }),
    );

    if (origPlatform) {
      Object.defineProperty(process, 'platform', origPlatform);
    }
  });

  it('uses "which gbrain" on non-Windows', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    mockExecSync.mockReturnValue(undefined);
    isGbrainInstalled();

    expect(mockExecSync).toHaveBeenCalledWith(
      'which gbrain',
      expect.objectContaining({ timeout: 3000 }),
    );

    if (origPlatform) {
      Object.defineProperty(process, 'platform', origPlatform);
    }
  });
});

describe('hasExternalGbrainConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when ~/.config/gbrain exists', () => {
    mockExistsSync.mockImplementation((p: unknown) =>
      String(p).endsWith('.config/gbrain'),
    );
    expect(hasExternalGbrainConfig()).toBe(true);
  });

  it('returns true when ~/.gbrain exists (legacy path)', () => {
    mockExistsSync.mockImplementation((p: unknown) =>
      String(p).endsWith('/.gbrain'),
    );
    expect(hasExternalGbrainConfig()).toBe(true);
  });

  it('returns false when neither path exists', () => {
    mockExistsSync.mockReturnValue(false);
    expect(hasExternalGbrainConfig()).toBe(false);
  });

  it('returns false when existsSync throws (defensive)', () => {
    mockExistsSync.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(hasExternalGbrainConfig()).toBe(false);
  });
});
