import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';

import {
  findFirstGgufModel,
  LlamaCppTextBackend,
} from '../llama-cpp-backend.js';

const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockStatSync = vi.mocked(statSync);

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

describe('LlamaCppTextBackend', () => {
  it('reports capabilities.available=true and modelName from path', () => {
    const port = new LlamaCppTextBackend({
      binaryPath: '/usr/bin/llama-cli',
      modelPath: '/models/phi-3-mini.gguf',
    });
    expect(port.capabilities.available).toBe(true);
    expect(port.capabilities.modelName).toBe('phi-3-mini.gguf');
    expect(port.capabilities.contextWindow).toBe(4096);
  });

  it('respects custom contextWindow', () => {
    const port = new LlamaCppTextBackend({
      binaryPath: '/usr/bin/llama-cli',
      modelPath: '/models/qwen.gguf',
      contextWindow: 32_768,
    });
    expect(port.capabilities.contextWindow).toBe(32_768);
  });

  it('passes prompt and options to llama-cli and returns stdout', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child as never);

    const port = new LlamaCppTextBackend({
      binaryPath: '/usr/bin/llama-cli',
      modelPath: '/models/phi.gguf',
    });

    const promise = port.generate('What is 2+2?', { maxTokens: 50, temperature: 0.2 });
    child.stdout.emit('data', Buffer.from('The answer is 4.'));
    child.emit('close', 0);

    const result = await promise;
    expect(result).toBe('The answer is 4.');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, args] = mockSpawn.mock.calls[0]!;
    expect(bin).toBe('/usr/bin/llama-cli');
    expect(args).toContain('-m');
    expect(args).toContain('/models/phi.gguf');
    expect(args).toContain('-p');
    expect(args).toContain('What is 2+2?');
    expect(args).toContain('-n');
    expect(args).toContain('50');
    expect(args).toContain('--temp');
    expect(args).toContain('0.2');
    expect(args).toContain('--no-display-prompt');
    expect(args).toContain('-no-cnv');
  });

  it('strips llama.cpp end-of-text markers from output', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child as never);

    const port = new LlamaCppTextBackend({
      binaryPath: '/usr/bin/llama-cli',
      modelPath: '/m.gguf',
    });

    const promise = port.generate('hi');
    child.stdout.emit('data', Buffer.from('Hello there. [end of text]\n'));
    child.emit('close', 0);
    expect(await promise).toBe('Hello there.');
  });

  it('rejects with stderr tail on non-zero exit', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child as never);

    const port = new LlamaCppTextBackend({
      binaryPath: '/usr/bin/llama-cli',
      modelPath: '/missing.gguf',
    });

    const promise = port.generate('hi');
    child.stderr.emit('data', Buffer.from('error: failed to load model\n'));
    child.emit('close', 1);

    await expect(promise).rejects.toThrow(/exited with code 1.*failed to load model/);
  });

  it('rejects on spawn error', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child as never);

    const port = new LlamaCppTextBackend({
      binaryPath: '/nope',
      modelPath: '/m.gguf',
    });
    const promise = port.generate('hi');
    child.emit('error', new Error('ENOENT'));
    await expect(promise).rejects.toThrow(/failed to spawn llama-cli.*ENOENT/);
  });

  it('kills child and rejects on timeout', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    mockSpawn.mockReturnValue(child as never);

    const port = new LlamaCppTextBackend({
      binaryPath: '/usr/bin/llama-cli',
      modelPath: '/m.gguf',
      timeoutMs: 1000,
    });

    const promise = port.generate('hi');
    vi.advanceTimersByTime(1500);
    await expect(promise).rejects.toThrow(/timed out after 1000ms/);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
  });

  it('passes -t threads when configured', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child as never);

    const port = new LlamaCppTextBackend({
      binaryPath: '/usr/bin/llama-cli',
      modelPath: '/m.gguf',
      threads: 8,
    });

    const promise = port.generate('hi');
    child.stdout.emit('data', Buffer.from('ok'));
    child.emit('close', 0);
    await promise;
    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toContain('-t');
    expect(args).toContain('8');
  });
});

describe('findFirstGgufModel', () => {
  it('returns null when dir is null', () => {
    expect(findFirstGgufModel(null)).toBeNull();
  });

  it('returns null when dir does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(findFirstGgufModel('/missing')).toBeNull();
  });

  it('returns first .gguf file in dir', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['readme.txt', 'phi.gguf', 'qwen.gguf'] as never);
    mockStatSync.mockReturnValue({ isFile: () => true } as never);
    expect(findFirstGgufModel('/models')).toBe('/models/phi.gguf');
  });

  it('skips non-gguf files', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['notes.md', 'config.json'] as never);
    expect(findFirstGgufModel('/models')).toBeNull();
  });

  it('skips entries that fail statSync', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['broken.gguf', 'good.gguf'] as never);
    mockStatSync
      .mockImplementationOnce(() => { throw new Error('perm denied'); })
      .mockImplementationOnce(() => ({ isFile: () => true } as never));
    expect(findFirstGgufModel('/models')).toBe('/models/good.gguf');
  });

  it('returns null when readdir throws', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockImplementation(() => { throw new Error('eperm'); });
    expect(findFirstGgufModel('/models')).toBeNull();
  });
});
