import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  EmbeddedTextCapabilities,
  EmbeddedTextPort,
} from './text-port.js';

export interface LlamaCppBackendOptions {
  binaryPath: string;
  modelPath: string;
  contextWindow?: number;
  timeoutMs?: number;
  threads?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONTEXT_WINDOW = 4096;

export class LlamaCppTextBackend implements EmbeddedTextPort {
  readonly capabilities: EmbeddedTextCapabilities;
  private readonly binaryPath: string;
  private readonly modelPath: string;
  private readonly timeoutMs: number;
  private readonly threads: number | null;

  constructor(opts: LlamaCppBackendOptions) {
    this.binaryPath = opts.binaryPath;
    this.modelPath = opts.modelPath;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.threads = opts.threads ?? null;
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
      const child = spawn(this.binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
