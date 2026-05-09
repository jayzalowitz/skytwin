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
  writeFileSync: vi.fn(),
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
  writeFileSync,
} from 'node:fs';

import {
  findFirstWhisperModel,
  parseWhisperJson,
  WhisperCppSttBackend,
} from '../whisper-cpp-backend.js';

const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdtempSync = vi.mocked(mkdtempSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockRmSync = vi.mocked(rmSync);
const mockStatSync = vi.mocked(statSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WhisperCppSttBackend', () => {
  it('reports capabilities.available=true and a non-empty supportedFormats list', () => {
    const port = new WhisperCppSttBackend({
      binaryPath: '/usr/bin/whisper-cli',
      modelPath: '/models/ggml-tiny.bin',
    });
    expect(port.capabilities.available).toBe(true);
    expect(port.capabilities.supportedFormats).toContain('wav');
    expect(port.capabilities.supportedFormats.length).toBeGreaterThan(0);
  });

  it('writes audio to temp file, spawns whisper-cli with -oj, parses JSON, cleans up', async () => {
    mockMkdtempSync.mockReturnValue('/tmp/skytwin-whisper-abc' as never);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ transcription: [{ text: 'hello' }, { text: 'world' }] }) as never,
    );

    const child = makeChild();
    mockSpawn.mockReturnValue(child as never);

    const port = new WhisperCppSttBackend({
      binaryPath: '/usr/bin/whisper-cli',
      modelPath: '/models/ggml-tiny.bin',
    });

    const audio = Buffer.from('PCM-AUDIO');
    const promise = port.transcribe(audio, { language: 'en' });
    child.emit('close', 0);

    const result = await promise;
    expect(result).toBe('hello world');

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/skytwin-whisper-abc/input.wav',
      audio,
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, args] = mockSpawn.mock.calls[0]!;
    expect(bin).toBe('/usr/bin/whisper-cli');
    expect(args).toContain('-m');
    expect(args).toContain('/models/ggml-tiny.bin');
    expect(args).toContain('-f');
    expect(args).toContain('/tmp/skytwin-whisper-abc/input.wav');
    expect(args).toContain('-oj');
    expect(args).toContain('-of');
    expect(args).toContain('/tmp/skytwin-whisper-abc/output');
    expect(args).toContain('-l');
    expect(args).toContain('en');

    expect(mockReadFileSync).toHaveBeenCalledWith(
      '/tmp/skytwin-whisper-abc/output.json',
      'utf8',
    );
    expect(mockRmSync).toHaveBeenCalledWith('/tmp/skytwin-whisper-abc', {
      recursive: true,
      force: true,
    });
  });

  it('cleans up temp dir even when whisper-cli exits non-zero', async () => {
    mockMkdtempSync.mockReturnValue('/tmp/skytwin-whisper-xyz' as never);

    const child = makeChild();
    mockSpawn.mockReturnValue(child as never);

    const port = new WhisperCppSttBackend({
      binaryPath: '/usr/bin/whisper-cli',
      modelPath: '/models/ggml-tiny.bin',
    });
    const promise = port.transcribe(Buffer.from('audio'));
    child.stderr.emit('data', Buffer.from('failed to read audio\n'));
    child.emit('close', 2);

    await expect(promise).rejects.toThrow(/exited with code 2/);
    expect(mockRmSync).toHaveBeenCalledWith('/tmp/skytwin-whisper-xyz', {
      recursive: true,
      force: true,
    });
  });

  it('rejects when whisper-cli exits 0 but JSON output is missing', async () => {
    mockMkdtempSync.mockReturnValue('/tmp/skytwin-whisper-q' as never);
    mockExistsSync.mockReturnValue(false);
    const child = makeChild();
    mockSpawn.mockReturnValue(child as never);

    const port = new WhisperCppSttBackend({
      binaryPath: '/usr/bin/whisper-cli',
      modelPath: '/m.bin',
    });
    const promise = port.transcribe(Buffer.from('audio'));
    child.emit('close', 0);

    await expect(promise).rejects.toThrow(/did not produce/);
  });

  it('omits -l flag when no language is given', async () => {
    mockMkdtempSync.mockReturnValue('/tmp/whx' as never);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ text: 'x' }) as never);
    const child = makeChild();
    mockSpawn.mockReturnValue(child as never);

    const port = new WhisperCppSttBackend({
      binaryPath: '/usr/bin/whisper-cli',
      modelPath: '/m.bin',
    });
    const promise = port.transcribe(Buffer.from('a'));
    child.emit('close', 0);
    await promise;

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).not.toContain('-l');
  });
});

describe('parseWhisperJson', () => {
  it('joins trimmed transcription[].text segments with single spaces', () => {
    expect(
      parseWhisperJson(
        JSON.stringify({ transcription: [{ text: 'hello ' }, { text: 'world' }] }),
      ),
    ).toBe('hello world');
  });

  it('falls back to top-level text when transcription is absent', () => {
    expect(parseWhisperJson(JSON.stringify({ text: 'fallback' }))).toBe('fallback');
  });

  it('returns empty string when no usable field is present', () => {
    expect(parseWhisperJson(JSON.stringify({}))).toBe('');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseWhisperJson('not-json')).toThrow(/invalid JSON/);
  });

  it('throws when JSON parses to a non-object', () => {
    expect(() => parseWhisperJson('null')).toThrow(/unexpected shape/);
    expect(() => parseWhisperJson('"a-string"')).toThrow(/unexpected shape/);
  });
});

describe('findFirstWhisperModel', () => {
  it('returns null when dir is null', () => {
    expect(findFirstWhisperModel(null)).toBeNull();
  });

  it('returns null when dir does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(findFirstWhisperModel('/m')).toBeNull();
  });

  it('returns first ggml-*.bin file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      'readme.md',
      'random.bin',
      'ggml-tiny.bin',
      'ggml-base.bin',
    ] as never);
    mockStatSync.mockReturnValue({ isFile: () => true } as never);
    expect(findFirstWhisperModel('/models')).toBe('/models/ggml-tiny.bin');
  });

  it('skips files that do not match the ggml-*.bin pattern', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['phi-3.bin', 'config.json'] as never);
    expect(findFirstWhisperModel('/m')).toBeNull();
  });
});
