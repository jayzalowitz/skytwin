/**
 * Piper TTS caller for the demo recorder (#414).
 *
 * Hits the running SkyTwin dev server's `/api/voice/synthesize`
 * endpoint, which delegates to the `@skytwin/embedded-llm` Piper
 * backend (spawn-based, local binary, no API key, deterministic for a
 * given `(text, voice)` pair).
 *
 * Cache: every (voice, text) pair gets sha256'd; the resulting WAV
 * lands in `out/narration-cache/<sha>.wav`. Re-running the recorder
 * after a copy edit only re-synthesises the changed lines. Identical
 * to the depobot pattern — the cache is what makes iteration cheap.
 *
 * The audio comes back base64-encoded; we decode and write the
 * binary WAV bytes straight to disk so ffmpeg can mux them later.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Timeline } from './timeline.js';
import { loadTimeline } from './timeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_API_BASE = process.env['SKYTWIN_API_BASE'] ?? 'http://localhost:3100';
/**
 * Recorder needs a userId to call /api/voice/synthesize — the
 * endpoint is per-user. Default uses the sample-profile userId.
 * Override by exporting `SKYTWIN_DEMO_USER_ID=<your-uuid>` or by
 * passing `{ userId }` into `synthesizeAll` directly. There's no
 * CLI flag — this is a small env-driven tool by design.
 */
const DEFAULT_USER_ID = process.env['SKYTWIN_DEMO_USER_ID'] ?? 'demo-user';

export interface NarrationFile {
  /** stable id from timeline.json (`step.id`). */
  stepId: string;
  /** Absolute path to the WAV file on disk. */
  wavPath: string;
  /** Bytes on disk; the recorder uses this to estimate clip duration. */
  bytes: number;
  /** True when this run took the cache, false when we re-synthesised. */
  fromCache: boolean;
}

interface SynthesizeResponse {
  audioBase64: string;
  audioBytes: number;
  voice: string;
}

function cacheKey(voice: string, text: string): string {
  return createHash('sha256')
    .update(`${voice}::${text}`, 'utf-8')
    .digest('hex')
    .slice(0, 32);
}

async function synthesizeOne(opts: {
  apiBase: string;
  userId: string;
  voice: string;
  text: string;
}): Promise<Buffer> {
  const url = `${opts.apiBase.replace(/\/+$/, '')}/api/voice/synthesize`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: opts.userId, text: opts.text, voice: opts.voice }),
  });
  if (!res.ok) {
    let detail: unknown;
    try { detail = await res.json(); } catch { detail = await res.text().catch(() => ''); }
    throw new Error(
      `Piper synthesize failed (${res.status}): ${JSON.stringify(detail).slice(0, 400)}` +
      `\n\nHint: confirm the API is running (\`pnpm dev\` from repo root)` +
      ` and that piper-cli + a voice model are installed — see` +
      ` packages/embedded-llm/README.md for the binary + model setup.`,
    );
  }
  const json = (await res.json()) as SynthesizeResponse;
  if (typeof json.audioBase64 !== 'string') {
    throw new Error('Piper response missing audioBase64');
  }
  return Buffer.from(json.audioBase64, 'base64');
}

/**
 * Synthesize narration for every step in `timeline`. Returns one
 * `NarrationFile` per step in declaration order. Cached WAVs are
 * reused; only the changed-text steps hit Piper.
 */
export async function synthesizeAll(opts: {
  timeline: Timeline;
  cacheDir: string;
  apiBase?: string;
  userId?: string;
}): Promise<NarrationFile[]> {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const userId = opts.userId ?? DEFAULT_USER_ID;
  if (!existsSync(opts.cacheDir)) {
    mkdirSync(opts.cacheDir, { recursive: true });
  }
  const out: NarrationFile[] = [];
  for (const step of opts.timeline.steps) {
    const key = cacheKey(opts.timeline.voice, step.narration);
    // Cache key is `<sha>.wav` — hash-only — so renaming a step in
    // timeline.json doesn't force a re-synthesis when the narration
    // text is unchanged. The step.id only shows up in log output, not
    // the cache filename, to preserve the "(voice, text)" cache
    // contract.
    const wavPath = join(opts.cacheDir, `${key}.wav`);
    if (existsSync(wavPath)) {
      const buf = readFileSync(wavPath);
      out.push({ stepId: step.id, wavPath, bytes: buf.length, fromCache: true });
      continue;
    }
    const audio = await synthesizeOne({
      apiBase,
      userId,
      voice: opts.timeline.voice,
      text: step.narration,
    });
    writeFileSync(wavPath, audio);
    out.push({ stepId: step.id, wavPath, bytes: audio.length, fromCache: false });
  }
  return out;
}

/**
 * Standalone entry: `tsx src/narrator.ts` synthesises every line in
 * timeline.json into the cache directory and prints a summary. Useful
 * for pre-generating narration before kicking off a long Playwright
 * run — you find a copy bug in the WAVs before the screenshots even
 * start.
 */
async function main(): Promise<void> {
  const timeline = loadTimeline();
  const cacheDir = resolve(__dirname, '..', 'out', 'narration-cache');
  const start = Date.now();
  const files = await synthesizeAll({ timeline, cacheDir });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  // eslint-disable-next-line no-console
  console.log(`Synthesized ${files.length} narration clips in ${elapsed}s:`);
  for (const f of files) {
    // eslint-disable-next-line no-console
    console.log(`  ${f.fromCache ? '·' : '+'} ${f.stepId.padEnd(18)} ${(f.bytes / 1024).toFixed(1)} KB`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
