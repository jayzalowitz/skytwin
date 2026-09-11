import { spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type {
  EmbeddedTextCapabilities,
  EmbeddedTextPort,
} from './text-port.js';
import { computeFileDescriptorSha256 } from './managed-model-store.js';

export interface LlamaCppBackendOptions {
  binaryPath: string;
  modelPath: string;
  contextWindow?: number;
  timeoutMs?: number;
  threads?: number;
  verifiedModel?: { exactBytes: number; sha256: string };
  spawnProcess?: typeof spawn;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONTEXT_WINDOW = 4096;

export class LlamaCppTextBackend implements EmbeddedTextPort {
  readonly capabilities: EmbeddedTextCapabilities;
  private readonly binaryPath: string;
  private readonly modelPath: string;
  private readonly timeoutMs: number;
  private readonly threads: number | null;
  private readonly verifiedModel: LlamaCppBackendOptions['verifiedModel'];
  private readonly spawnProcess: typeof spawn;

  constructor(opts: LlamaCppBackendOptions) {
    this.binaryPath = opts.binaryPath;
    this.modelPath = opts.modelPath;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.threads = opts.threads ?? null;
    this.verifiedModel = opts.verifiedModel;
    this.spawnProcess = opts.spawnProcess ?? spawn;
    this.capabilities = {
      available: true,
      modelName: basename(opts.modelPath),
      contextWindow: opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    };
  }

  async generate(
    prompt: string,
    opts: { maxTokens?: number; temperature?: number } = {},
  ): Promise<string> {
    const verifiedIdentity = this.verifiedModel
      ? verifyModelForLaunch(this.modelPath, this.verifiedModel)
      : null;
    const maxTokens = opts.maxTokens ?? 512;
    const temperature = opts.temperature ?? 0.7;
    const args = [
      '-m', this.modelPath,
      '-p', prompt,
      '-n', String(maxTokens),
      '--temp', String(temperature),
      '--no-display-prompt',
      '--no-warmup',
      '-no-cnv',
    ];
    if (this.threads !== null) {
      args.push('-t', String(this.threads));
    }

    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      if (verifiedIdentity !== null) {
        try {
          const after = statSync(this.modelPath, { bigint: true });
          if (after.dev !== verifiedIdentity.dev || after.ino !== verifiedIdentity.ino) {
            child.kill('SIGKILL');
            reject(new Error('managed model changed at the runtime launch boundary'));
            return;
          }
        } catch {
          child.kill('SIGKILL');
          reject(new Error('managed model became unavailable at the runtime launch boundary'));
          return;
        }
      }
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`llama-cli timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`failed to spawn llama-cli: ${err.message}`));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const tail = stderr.split('\n').slice(-5).join('\n').trim();
          reject(new Error(`llama-cli exited with code ${code ?? 'null'}: ${tail || 'no stderr'}`));
          return;
        }
        resolve(stripEndOfTextMarker(stdout).trim());
      });
    });
  }
}

function verifyModelForLaunch(
  path: string,
  expected: { exactBytes: number; sha256: string },
): { dev: bigint; ino: bigint } {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || Number(before.size) !== expected.exactBytes) {
      throw new Error('managed model identity check failed before runtime launch');
    }
    // Hash the descriptor already subjected to the no-follow and identity
    // checks. Reopening the pathname here would introduce a second race.
    const actual = computeFileDescriptorSha256(fd);
    const after = fstatSync(fd, { bigint: true });
    if (
      actual !== expected.sha256 ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw new Error('managed model integrity check failed before runtime launch');
    }
    return { dev: before.dev, ino: before.ino };
  } finally {
    closeSync(fd);
  }
}


function stripEndOfTextMarker(text: string): string {
  return text
    .replace(/\[end of text\]\s*$/i, '')
    .replace(/<\|im_end\|>\s*$/i, '')
    .replace(/<\|endoftext\|>\s*$/i, '')
    .replace(/<\/s>\s*$/i, '');
}

const GGUF_EXTENSIONS = new Set(['.gguf']);

export function findFirstGgufModel(dir: string | null): string | null {
  if (dir === null || dir === '' || !existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    const ext = lower.slice(lower.lastIndexOf('.'));
    if (!GGUF_EXTENSIONS.has(ext)) continue;
    const full = join(dir, entry);
    try {
      if (statSync(full).isFile()) return full;
    } catch {
      continue;
    }
  }
  return null;
}
