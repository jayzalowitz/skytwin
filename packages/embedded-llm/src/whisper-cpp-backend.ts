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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EmbeddedSttCapabilities,
  EmbeddedSttPort,
} from './stt-port.js';

export interface WhisperCppBackendOptions {
  binaryPath: string;
  modelPath: string;
  timeoutMs?: number;
  threads?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const SUPPORTED_FORMATS = ['wav', 'mp3', 'flac', 'ogg'];

interface WhisperJsonOutput {
  transcription?: Array<{ text?: string }>;
  text?: string;
}

export class WhisperCppSttBackend implements EmbeddedSttPort {
  readonly capabilities: EmbeddedSttCapabilities = {
    available: true,
    supportedFormats: SUPPORTED_FORMATS,
  };

  private readonly binaryPath: string;
  private readonly modelPath: string;
  private readonly timeoutMs: number;
  private readonly threads: number | null;

  constructor(opts: WhisperCppBackendOptions) {
    this.binaryPath = opts.binaryPath;
    this.modelPath = opts.modelPath;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.threads = opts.threads ?? null;
  }

  async transcribe(audio: Buffer, opts: { language?: string } = {}): Promise<string> {
    const work = mkdtempSync(join(tmpdir(), 'skytwin-whisper-'));
    const audioPath = join(work, 'input.wav');
    const outBase = join(work, 'output');
    writeFileSync(audioPath, audio);

    const args = [
      '-m', this.modelPath,
      '-f', audioPath,
      '-oj',
      '-of', outBase,
      '-np',
      '-nt',
    ];
    if (opts.language !== undefined && opts.language !== '') {
      args.push('-l', opts.language);
    }
    if (this.threads !== null) {
      args.push('-t', String(this.threads));
    }

    try {
      await this.spawnWhisper(args);
      const jsonPath = `${outBase}.json`;
      if (!existsSync(jsonPath)) {
        throw new Error(`whisper-cli completed but did not produce ${jsonPath}`);
      }
      const raw = readFileSync(jsonPath, 'utf8');
      return parseWhisperJson(raw);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  private spawnWhisper(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`whisper-cli timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`failed to spawn whisper-cli: ${err.message}`));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const tail = stderr.split('\n').slice(-5).join('\n').trim();
          reject(new Error(`whisper-cli exited with code ${code ?? 'null'}: ${tail || 'no stderr'}`));
          return;
        }
        resolve();
      });
    });
  }
}

export function parseWhisperJson(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('whisper-cli produced invalid JSON');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('whisper-cli JSON output had unexpected shape');
  }
  const obj = parsed as WhisperJsonOutput;
  if (Array.isArray(obj.transcription)) {
    return obj.transcription
      .map((seg) => (typeof seg.text === 'string' ? seg.text.trim() : ''))
      .filter((s) => s !== '')
      .join(' ')
      .trim();
  }
  if (typeof obj.text === 'string') return obj.text.trim();
  return '';
}

const WHISPER_MODEL_EXTENSIONS = new Set(['.bin']);

export function findFirstWhisperModel(dir: string | null): string | null {
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
    if (!WHISPER_MODEL_EXTENSIONS.has(ext)) continue;
    if (!lower.startsWith('ggml-')) continue;
    const full = join(dir, entry);
    try {
      if (statSync(full).isFile()) return full;
    } catch {
      continue;
    }
  }
  return null;
}
