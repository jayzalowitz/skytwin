import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  EmbeddedTtsCapabilities,
  EmbeddedTtsPort,
} from './tts-port.js';

export interface PiperTtsBackendOptions {
  /** Absolute path to the `piper` binary (or a wrapper). */
  binaryPath: string;
  /**
   * Absolute path to the `.onnx` voice model. Piper expects a paired
   * `<model>.onnx.json` config file in the same directory; we do not
   * pass it explicitly because piper resolves it by convention.
   */
  modelPath: string;
  /** Optional cap on synth time. Default 60s — Piper is fast (~0.3 RTF on CPU). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * Hard ceiling on synthesized text length. Real-world usage is briefing
 * paragraphs (~500 chars) and approval prompts (~200 chars); a stray
 * 10MB string would lock up piper for minutes. 8000 chars covers the
 * 99.9% case while still bounding worst-case wall-time.
 */
const MAX_TEXT_LENGTH = 8000;
const PIPER_MODEL_EXTENSIONS = new Set(['.onnx']);

/**
 * `synthesize()` advertises one voice slot — the model file loaded at
 * construction time. Piper supports multiple voices via separate model
 * files; switching voices requires re-instantiating the backend with a
 * different `modelPath`. We surface the current voice as
 * `<filename-without-extension>` so callers can render it in the UI.
 */
function voiceNameFromModelPath(modelPath: string): string {
  const base = basename(modelPath);
  const dotIdx = base.lastIndexOf('.');
  return dotIdx > 0 ? base.slice(0, dotIdx) : base;
}

/**
 * Real Piper-backed `EmbeddedTtsPort` (#187 AC#4).
 *
 * Spawns the `piper` CLI with `--model <model.onnx>` and
 * `--output_file <tmpfile>`, writes the text to stdin, waits for exit,
 * then reads the resulting WAV into a Buffer. Cleans up the tempdir on
 * both success and failure.
 *
 * Mirrors the spawn pattern of `WhisperCppSttBackend` so the failure
 * modes (timeout / non-zero exit / missing output file) are reported
 * with the same diagnostics shape.
 *
 * Tested with the official Piper releases from
 * github.com/rhasspy/piper (binary names: `piper` on Linux/macOS,
 * `piper.exe` on Windows). Voice models live alongside their `.json`
 * config; the convention is `en_US-amy-medium.onnx` +
 * `en_US-amy-medium.onnx.json`.
 */
export class PiperTtsBackend implements EmbeddedTtsPort {
  readonly capabilities: EmbeddedTtsCapabilities;

  private readonly binaryPath: string;
  private readonly modelPath: string;
  private readonly timeoutMs: number;
  private readonly voiceName: string;

  constructor(opts: PiperTtsBackendOptions) {
    this.binaryPath = opts.binaryPath;
    this.modelPath = opts.modelPath;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.voiceName = voiceNameFromModelPath(opts.modelPath);
    this.capabilities = {
      available: true,
      voices: [this.voiceName],
    };
  }

  async synthesize(text: string, opts: { voice?: string } = {}): Promise<Buffer> {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('piper: text is required');
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new Error(
        `piper: text length ${text.length} exceeds maximum ${MAX_TEXT_LENGTH}`,
      );
    }
    if (opts.voice !== undefined && opts.voice !== '' && opts.voice !== this.voiceName) {
      // Hard fail rather than silently ignore — a caller asking for a
      // specific voice expects either that voice or an error, not "I
      // pretended you didn't ask." Re-instantiate the backend with a
      // matching modelPath to switch voices.
      throw new Error(
        `piper: voice "${opts.voice}" not available; this backend serves "${this.voiceName}"`,
      );
    }

    const work = mkdtempSync(join(tmpdir(), 'skytwin-piper-'));
    const outPath = join(work, 'out.wav');
    const args = [
      '--model', this.modelPath,
      '--output_file', outPath,
      // `--quiet` suppresses banner + progress output on stderr so the
      // diagnostics tail we collect on failure isn't 90% noise.
      '--quiet',
    ];

    try {
      await this.spawnPiper(args, text);
      if (!existsSync(outPath)) {
        throw new Error(`piper completed but did not produce ${outPath}`);
      }
      const wav = readFileSync(outPath);
      if (wav.length === 0) {
        throw new Error('piper produced an empty WAV file');
      }
      return wav;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  private spawnPiper(args: string[], stdinText: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`piper timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`failed to spawn piper: ${err.message}`));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const tail = stderr.split('\n').slice(-5).join('\n').trim();
          reject(new Error(`piper exited with code ${code ?? 'null'}: ${tail || 'no stderr'}`));
          return;
        }
        resolve();
      });

      // Write the text to piper's stdin and close. Piper reads from
      // stdin in newline-delimited mode by default — we send the
      // entire text as one line so the output is a single utterance
      // rather than chunked into sentence-per-WAV.
      child.stdin?.write(stdinText);
      child.stdin?.end();
    });
  }
}

/**
 * Find the first usable Piper voice model in a directory. Returns null
 * when the directory is missing, empty, or contains no `.onnx` file
 * paired with a `<model>.onnx.json` config (Piper requires both).
 *
 * The pairing check is what differentiates a usable voice model from a
 * stray `.onnx` file someone dropped in — a `.onnx` without a config
 * will throw a confusing error at synth time. Catching it at detection
 * keeps the failure visible at boot.
 */
export function findFirstPiperModel(dir: string | null): string | null {
  if (dir === null || dir === '' || !existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    const dot = lower.lastIndexOf('.');
    if (dot < 0) continue;
    const ext = lower.slice(dot);
    if (!PIPER_MODEL_EXTENSIONS.has(ext)) continue;
    const full = join(dir, entry);
    const config = `${full}.json`;
    try {
      if (!statSync(full).isFile()) continue;
      if (!existsSync(config)) continue;
    } catch {
      continue;
    }
    return full;
  }
  return null;
}
