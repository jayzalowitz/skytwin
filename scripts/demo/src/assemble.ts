/**
 * ffmpeg orchestration for the demo recorder (#414).
 *
 * Two passes:
 *
 *   1. **Image sequence → silent video.** The screenshots Playwright
 *      captured at `timeline.fps` get assembled into an H.264 mp4 at
 *      the same frame rate. No audio yet.
 *   2. **Mux narration onto the silent video.** Each step's
 *      Piper-synthesised WAV is delayed to its cumulative start time
 *      (so step 4's WAV starts at second `sum(durations[0..3])`),
 *      then `amix`'d into a single audio track and copied alongside
 *      the H.264 stream.
 *
 * The result lands at `out/demo.mp4` next to the screenshot dir +
 * the narration cache. Deterministic: same timeline.json + same
 * Piper voice model = same bytes. The frames are themselves
 * deterministic only when the dashboard's content is — that's why
 * the recorder pre-seeds the sample-profile userId rather than
 * letting a real Gmail signal stream drift between runs.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Timeline } from './timeline.js';
import type { NarrationFile } from './narrator.js';
import { stepStartTimes, totalDuration } from './timeline.js';

export interface AssembleOpts {
  timeline: Timeline;
  framesDir: string;
  /** Pattern fragment used by Playwright: `frame-%06d.png`. */
  framePattern?: string;
  narration: NarrationFile[];
  outputPath: string;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        rejectFn(new Error(
          'ffmpeg not found on PATH. Install via Homebrew (`brew install ffmpeg`)' +
          ' or your platform package manager before running the recorder.',
        ));
        return;
      }
      rejectFn(err);
    });
    child.on('exit', (code) => {
      if (code === 0) resolveFn();
      else rejectFn(new Error(`ffmpeg exited with code ${code ?? '?'}`));
    });
  });
}

function frameCount(framesDir: string): number {
  if (!existsSync(framesDir)) return 0;
  return readdirSync(framesDir).filter((f) => f.endsWith('.png')).length;
}

export async function assemble(opts: AssembleOpts): Promise<void> {
  const framePattern = opts.framePattern ?? 'frame-%06d.png';
  const fps = opts.timeline.fps;
  const totalSecs = totalDuration(opts.timeline);
  const haveFrames = frameCount(opts.framesDir);

  if (haveFrames === 0) {
    throw new Error(`No screenshots found under ${opts.framesDir}. Run the recorder first.`);
  }
  if (haveFrames < Math.floor(totalSecs * fps * 0.9)) {
    // Fewer than 90% of the expected frames usually means Playwright
    // tripped over something mid-run. Better to fail loud than mux a
    // truncated mp4 the user only notices after they upload it.
    throw new Error(
      `Frame undercount: expected ~${Math.floor(totalSecs * fps)} (` +
      `${totalSecs}s × ${fps}fps), found ${haveFrames}. The recorder probably` +
      ` errored before the timeline finished — check the recorder logs.`,
    );
  }

  // Pass 1: image sequence → silent H.264 mp4.
  // -framerate sets the input rate so PNGs are read as 1fps; -r on
  // the output forces the same rate so the playback speed matches the
  // narrator cue clock.
  const inputPattern = resolve(opts.framesDir, framePattern);
  const silentMp4 = resolve(opts.outputPath.replace(/\.mp4$/i, '') + '.silent.mp4');
  await runFfmpeg([
    '-framerate', String(fps),
    '-i', inputPattern,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-movflags', '+faststart',
    silentMp4,
  ]);

  // Pass 2: mux narration at cumulative offsets.
  // Build one `-i` per narration clip + a filter_complex that delays
  // each clip to its step's start-time-ms and amixes them. Then take
  // the video from the silent mp4 unchanged.
  const starts = stepStartTimes(opts.timeline);
  const narrationByStep = new Map(opts.narration.map((n) => [n.stepId, n]));
  const audioInputs: string[] = [];
  const filterParts: string[] = [];
  let mixIdx = 0;
  for (const step of opts.timeline.steps) {
    const file = narrationByStep.get(step.id);
    if (!file) continue;
    const startMs = Math.round(starts[step.id]! * 1000);
    audioInputs.push('-i', file.wavPath);
    // Each clip = input index (1 + mixIdx, because input 0 is silent video) with delay applied:
    //   [N:a]adelay=<ms>|<ms>[aN]
    filterParts.push(`[${mixIdx + 1}:a]adelay=${startMs}|${startMs}[a${mixIdx}]`);
    mixIdx++;
  }
  if (mixIdx === 0) {
    throw new Error('No narration clips to mux — narration cache is empty.');
  }
  const mixInputs = Array.from({ length: mixIdx }, (_, i) => `[a${i}]`).join('');
  const filterComplex = [
    ...filterParts,
    `${mixInputs}amix=inputs=${mixIdx}:duration=longest:dropout_transition=0[aout]`,
  ].join(';');

  await runFfmpeg([
    '-i', silentMp4,
    ...audioInputs,
    '-filter_complex', filterComplex,
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    opts.outputPath,
  ]);
}
