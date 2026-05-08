import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectEmbeddedRuntimes } from '../runtime-detector.js';

// We mock child_process and fs so we never spawn real binaries.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);

function clearRuntimeEnvVars() {
  delete process.env['SKYTWIN_LLAMACPP_BIN'];
  delete process.env['SKYTWIN_WHISPER_BIN'];
  delete process.env['SKYTWIN_PIPER_BIN'];
  delete process.env['SKYTWIN_LLAMA_MODELS'];
  delete process.env['SKYTWIN_WHISPER_MODELS'];
  delete process.env['SKYTWIN_PIPER_MODELS'];
}

beforeEach(() => {
  clearRuntimeEnvVars();
  vi.resetAllMocks();
});

afterEach(() => {
  clearRuntimeEnvVars();
});

describe('detectEmbeddedRuntimes', () => {
  it('returns available:false for all runtimes when no binary is found in PATH and no env vars set', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const result = await detectEmbeddedRuntimes();

    expect(result.llamaCpp.available).toBe(false);
    expect(result.llamaCpp.binaryPath).toBeNull();
    expect(result.whisper.available).toBe(false);
    expect(result.whisper.binaryPath).toBeNull();
    expect(result.piper.available).toBe(false);
    expect(result.piper.binaryPath).toBeNull();
  });

  it('prefers SKYTWIN_LLAMACPP_BIN env var over PATH lookup when the path exists', async () => {
    process.env['SKYTWIN_LLAMACPP_BIN'] = '/opt/local/bin/llama-cli';
    mockExistsSync.mockReturnValue(true);
    // execSync should NOT be called for llama when env var is set and path exists.
    mockExecSync.mockImplementation(() => {
      throw new Error('should not be called');
    });

    const result = await detectEmbeddedRuntimes();

    expect(result.llamaCpp.available).toBe(true);
    expect(result.llamaCpp.binaryPath).toBe('/opt/local/bin/llama-cli');
  });

  it('returns available:false when SKYTWIN_LLAMACPP_BIN is set but path does not exist', async () => {
    process.env['SKYTWIN_LLAMACPP_BIN'] = '/nonexistent/llama-cli';
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const result = await detectEmbeddedRuntimes();

    expect(result.llamaCpp.available).toBe(false);
    expect(result.llamaCpp.binaryPath).toBeNull();
  });

  it('detects all three runtimes as available when all binaries are present in PATH', async () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('llama-cli')) return Buffer.from('/usr/local/bin/llama-cli\n');
      if (cmdStr.includes('whisper-cli')) return Buffer.from('/usr/local/bin/whisper-cli\n');
      if (cmdStr.includes('piper')) return Buffer.from('/usr/local/bin/piper\n');
      throw new Error('unknown');
    });

    const result = await detectEmbeddedRuntimes();

    expect(result.llamaCpp.available).toBe(true);
    expect(result.llamaCpp.binaryPath).toBe('/usr/local/bin/llama-cli');
    expect(result.whisper.available).toBe(true);
    expect(result.whisper.binaryPath).toBe('/usr/local/bin/whisper-cli');
    expect(result.piper.available).toBe(true);
    expect(result.piper.binaryPath).toBe('/usr/local/bin/piper');
  });

  it('handles partial detection (one available, two not)', async () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('whisper-cli')) return Buffer.from('/usr/bin/whisper-cli\n');
      throw new Error('not found');
    });

    const result = await detectEmbeddedRuntimes();

    expect(result.llamaCpp.available).toBe(false);
    expect(result.whisper.available).toBe(true);
    expect(result.whisper.binaryPath).toBe('/usr/bin/whisper-cli');
    expect(result.piper.available).toBe(false);
  });

  it('resolves model dirs from env vars independently of binary availability', async () => {
    process.env['SKYTWIN_LLAMA_MODELS'] = '/models/llama';
    process.env['SKYTWIN_WHISPER_MODELS'] = '/models/whisper';
    process.env['SKYTWIN_PIPER_MODELS'] = '/models/piper';
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const result = await detectEmbeddedRuntimes();

    expect(result.llamaCpp.modelDir).toBe('/models/llama');
    expect(result.whisper.modelDir).toBe('/models/whisper');
    expect(result.piper.modelDir).toBe('/models/piper');
    // Available is still false — model dir alone doesn't make a runtime available.
    expect(result.llamaCpp.available).toBe(false);
  });

  it('returns null modelDir when no model dir env var is set', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const result = await detectEmbeddedRuntimes();

    expect(result.llamaCpp.modelDir).toBeNull();
    expect(result.whisper.modelDir).toBeNull();
    expect(result.piper.modelDir).toBeNull();
  });

  it('uses SKYTWIN_WHISPER_BIN and SKYTWIN_PIPER_BIN env-var overrides', async () => {
    process.env['SKYTWIN_WHISPER_BIN'] = '/custom/whisper-cli';
    process.env['SKYTWIN_PIPER_BIN'] = '/custom/piper';
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation(() => {
      throw new Error('should not be called for whisper or piper');
    });

    const result = await detectEmbeddedRuntimes();

    expect(result.whisper.available).toBe(true);
    expect(result.whisper.binaryPath).toBe('/custom/whisper-cli');
    expect(result.piper.available).toBe(true);
    expect(result.piper.binaryPath).toBe('/custom/piper');
  });
});
