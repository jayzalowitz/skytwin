import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdtempSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
}));
vi.mock('node:os', () => ({ tmpdir: vi.fn(() => '/tmp') }));

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';

import {
  findFirstPiperModel,
  PiperTtsBackend,
} from '../piper-tts-backend.js';

const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdtempSync = vi.mocked(mkdtempSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockRmSync = vi.mocked(rmSync);
const mockStatSync = vi.mocked(statSync);

interface FakeChild extends EventEmitter {
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PiperTtsBackend — capabilities', () => {
  it('advertises available=true and a voice list containing the loaded model name', () => {
    const port = new PiperTtsBackend({
      binaryPath: '/usr/bin/piper',
      modelPath: '/voices/en_US-amy-medium.onnx',
    });
    expect(port.capabilities.available).toBe(true);
    expect(port.capabilities.voices).toEqual(['en_US-amy-medium']);
  });

  it('handles voice-name extraction on model paths without an extension', () => {
    const port = new PiperTtsBackend({
      binaryPath: '/piper',
      modelPath: '/voices/anonymous',
    });
    expect(port.capabilities.voices).toEqual(['anonymous']);
  });
});

describe('PiperTtsBackend.synthesize', () => {
  it('writes text to stdin, spawns piper with --model + --output_file + --quiet, returns WAV buffer, cleans up', async () => {
    mockMkdtempSync.mockReturnValue('/tmp/skytwin-piper-abc' as never);
    mockExistsSync.mockReturnValue(true);
    const wavBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]); // 'RIFF' header start
    mockReadFileSync.mockReturnValue(wavBytes as never);

    const child = makeChild();
    mockSpawn.mockReturnValue(child as never);

    const port = new PiperTtsBackend({
      binaryPath: '/usr/bin/piper',
      modelPath: '/voices/en_US-amy-medium.onnx',
    });

    const promise = port.synthesize('hello twin');
    child.emit('close', 0);

    const result = await promise;
    expect(result).toBe(wavBytes);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, args] = mockSpawn.mock.calls[0]!;
    expect(bin).toBe('/usr/bin/piper');
    expect(args).toContain('--model');
    expect(args).toContain('/voices/en_US-amy-medium.onnx');
    expect(args).toContain('--output_file');
    expect(args).toContain('/tmp/skytwin-piper-abc/out.wav');
    expect(args).toContain('--quiet');

    // Text written to stdin verbatim then stream closed
    expect(child.stdin.write).toHaveBeenCalledWith('hello twin');
    expect(child.stdin.end).toHaveBeenCalled();

    expect(mockReadFileSync).toHaveBeenCalledWith('/tmp/skytwin-piper-abc/out.wav');
    expect(mockRmSync).toHaveBeenCalledWith('/tmp/skytwin-piper-abc', {
      recursive: true,
      force: true,
    });
  });

  it('cleans up temp dir on non-zero exit and surfaces the stderr tail', async () => {
    mockMkdtempSync.mockReturnValue('/tmp/skytwin-piper-xyz' as never);
    const child = makeChild();
    mockSpawn.mockReturnValue(child as never);

    const port = new PiperTtsBackend({
      binaryPath: '/usr/bin/piper',
      modelPath: '/voices/x.onnx',
    });
    const promise = port.synthesize('any text');
    child.stderr.emit('data', Buffer.from('config not found\n'));
    child.emit('close', 1);

    // Assert error shape with one rejection catch — calling
    // rejects.toThrow on the same promise twice can mask the first
    // error and obscure which property failed the regex.
    let captured: unknown = null;
    try { await promise; } catch (err) { captured = err; }
    expect(captured).toBeInstanceOf(Error);
    const msg = (captured as Error).message;
    expect(msg).toMatch(/exited with code 1/);
    expect(msg).toMatch(/config not found/);
    expect(mockRmSync).toHaveBeenCalledWith('/tmp/skytwin-piper-xyz', {
      recursive: true,
      force: true,
    });
  });

  it('rejects when piper exits 0 but the WAV file is missing', async () => {
    mockMkdtempSync.mockReturnValue('/tmp/skytwin-piper-q' as never);
    mockExistsSync.mockReturnValue(false);
    const child = makeChild();
    mockSpawn.mockReturnValue(child as never);

    const port = new PiperTtsBackend({
      binaryPath: '/usr/bin/piper',
      modelPath: '/v.onnx',
    });
    const promise = port.synthesize('hello');
    child.emit('close', 0);

    await expect(promise).rejects.toThrow(/did not produce/);
  });

  it('rejects when piper exits 0 but the WAV file is empty', async () => {
    mockMkdtempSync.mockReturnValue('/tmp/skytwin-piper-e' as never);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(Buffer.alloc(0) as never);
    const child = makeChild();
    mockSpawn.mockReturnValue(child as never);

    const port = new PiperTtsBackend({
      binaryPath: '/usr/bin/piper',
      modelPath: '/v.onnx',
    });
    const promise = port.synthesize('hello');
    child.emit('close', 0);

    await expect(promise).rejects.toThrow(/empty WAV/);
  });

  it('throws synchronously on empty text — never spawns piper', async () => {
    const port = new PiperTtsBackend({
      binaryPath: '/p',
      modelPath: '/v.onnx',
    });
    await expect(port.synthesize('')).rejects.toThrow(/text is required/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('throws on text exceeding 8000 chars — never spawns piper', async () => {
    const port = new PiperTtsBackend({
      binaryPath: '/p',
      modelPath: '/v.onnx',
    });
    const long = 'x'.repeat(8001);
    await expect(port.synthesize(long)).rejects.toThrow(/exceeds maximum/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('throws when caller requests a different voice than the loaded one', async () => {
    const port = new PiperTtsBackend({
      binaryPath: '/p',
      modelPath: '/voices/en_US-amy-medium.onnx',
    });
    await expect(port.synthesize('hi', { voice: 'en_US-ryan' })).rejects.toThrow(
      /not available/,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('accepts a matching voice name without rejection', async () => {
    mockMkdtempSync.mockReturnValue('/tmp/skytwin-piper-v' as never);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(Buffer.from([0x52, 0x49, 0x46, 0x46]) as never);
    const child = makeChild();
    mockSpawn.mockReturnValue(child as never);

    const port = new PiperTtsBackend({
      binaryPath: '/p',
      modelPath: '/voices/en_US-amy-medium.onnx',
    });
    const promise = port.synthesize('hi', { voice: 'en_US-amy-medium' });
    child.emit('close', 0);
    await expect(promise).resolves.toBeInstanceOf(Buffer);
  });
});

describe('findFirstPiperModel', () => {
  it('returns null when dir is null or empty', () => {
    expect(findFirstPiperModel(null)).toBeNull();
    expect(findFirstPiperModel('')).toBeNull();
  });

  it('returns null when dir does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(findFirstPiperModel('/voices')).toBeNull();
  });

  it('returns the first .onnx with a paired .onnx.json config', () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      // Dir exists; the .onnx file exists; only en_US-amy.onnx has a paired config.
      if (path === '/voices') return true;
      if (path === '/voices/orphan.onnx') return true;
      if (path === '/voices/orphan.onnx.json') return false;
      if (path === '/voices/en_US-amy.onnx') return true;
      if (path === '/voices/en_US-amy.onnx.json') return true;
      return false;
    });
    mockReaddirSync.mockReturnValue(['orphan.onnx', 'en_US-amy.onnx', 'README.md'] as never);
    mockStatSync.mockReturnValue({ isFile: () => true } as never);
    expect(findFirstPiperModel('/voices')).toBe('/voices/en_US-amy.onnx');
  });

  it('skips files that are not .onnx', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['model.bin', 'config.json', 'readme.txt'] as never);
    mockStatSync.mockReturnValue({ isFile: () => true } as never);
    expect(findFirstPiperModel('/voices')).toBeNull();
  });

  it('skips .onnx files without a paired .onnx.json config', () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/voices') return true;
      if (path === '/voices/lonely.onnx') return true;
      if (path === '/voices/lonely.onnx.json') return false;
      return false;
    });
    mockReaddirSync.mockReturnValue(['lonely.onnx'] as never);
    mockStatSync.mockReturnValue({ isFile: () => true } as never);
    expect(findFirstPiperModel('/voices')).toBeNull();
  });
});
