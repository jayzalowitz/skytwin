/**
 * Timeline schema + loader for the demo recorder (#414).
 *
 * The recorder reads `timeline.json` from the package root, validates
 * the shape, and exposes a typed view. Validation is intentionally
 * strict — a typo in the schema would otherwise silently produce a
 * broken video.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Discrete actions a step can ask Playwright to perform. The recorder
 * walks them sequentially within a step; if they finish faster than
 * `step.durationSeconds`, the recorder keeps capturing screenshots
 * until the cue clock catches up.
 */
export type StepAction =
  | { kind: 'goto'; url: string }
  | { kind: 'click'; selector: string }
  | { kind: 'waitForSelector'; selector: string }
  | { kind: 'waitForUrl'; pattern: string }
  | { kind: 'scroll-to'; selector: string }
  | { kind: 'screenshot-hold' };

export interface TimelineStep {
  id: string;
  /** Wall-clock seconds this step occupies in the final video. */
  durationSeconds: number;
  /** Plain-English line passed to Piper TTS. */
  narration: string;
  actions: StepAction[];
}

export interface Timeline {
  /** Frame rate for screenshot capture and final video. */
  fps: number;
  viewport: { width: number; height: number };
  /** Piper voice id — must match a voice on the running embedded-llm. */
  voice: string;
  steps: TimelineStep[];
}

function isStepAction(value: unknown): value is StepAction {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v['kind']) {
    case 'goto':
      return typeof v['url'] === 'string';
    case 'click':
    case 'waitForSelector':
    case 'scroll-to':
      return typeof v['selector'] === 'string';
    case 'waitForUrl':
      return typeof v['pattern'] === 'string';
    case 'screenshot-hold':
      return true;
    default:
      return false;
  }
}

/**
 * Parse + validate a timeline payload. Throws on any shape violation
 * — we'd rather fail at load time than produce a broken mp4.
 */
export function parseTimeline(raw: unknown): Timeline {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('timeline.json: root must be an object');
  }
  const o = raw as Record<string, unknown>;
  const fps = o['fps'];
  if (typeof fps !== 'number' || fps <= 0 || !Number.isFinite(fps)) {
    throw new Error('timeline.json: fps must be a positive finite number');
  }
  const viewport = o['viewport'] as Record<string, unknown> | undefined;
  if (
    !viewport ||
    typeof viewport['width'] !== 'number' ||
    typeof viewport['height'] !== 'number'
  ) {
    throw new Error('timeline.json: viewport must have numeric width + height');
  }
  if (typeof o['voice'] !== 'string' || o['voice'].length === 0) {
    throw new Error('timeline.json: voice must be a non-empty string');
  }
  if (!Array.isArray(o['steps']) || o['steps'].length === 0) {
    throw new Error('timeline.json: steps must be a non-empty array');
  }
  const steps: TimelineStep[] = [];
  for (let i = 0; i < o['steps'].length; i++) {
    const step = o['steps'][i];
    if (typeof step !== 'object' || step === null) {
      throw new Error(`timeline.json: step[${i}] must be an object`);
    }
    const s = step as Record<string, unknown>;
    if (typeof s['id'] !== 'string' || s['id'].length === 0) {
      throw new Error(`timeline.json: step[${i}].id must be a non-empty string`);
    }
    if (
      typeof s['durationSeconds'] !== 'number' ||
      s['durationSeconds'] <= 0 ||
      !Number.isFinite(s['durationSeconds'])
    ) {
      throw new Error(`timeline.json: step[${i}].durationSeconds must be a positive finite number`);
    }
    if (typeof s['narration'] !== 'string' || s['narration'].length === 0) {
      throw new Error(`timeline.json: step[${i}].narration must be a non-empty string`);
    }
    if (!Array.isArray(s['actions'])) {
      throw new Error(`timeline.json: step[${i}].actions must be an array`);
    }
    const actions: StepAction[] = [];
    for (let j = 0; j < s['actions'].length; j++) {
      const a = s['actions'][j];
      if (!isStepAction(a)) {
        throw new Error(
          `timeline.json: step[${i}].actions[${j}] is malformed (kind="${(a as { kind?: unknown })?.kind ?? '?'}")`,
        );
      }
      actions.push(a);
    }
    steps.push({
      id: s['id'],
      durationSeconds: s['durationSeconds'],
      narration: s['narration'],
      actions,
    });
  }
  return {
    fps,
    viewport: { width: viewport['width'] as number, height: viewport['height'] as number },
    voice: o['voice'],
    steps,
  };
}

export function loadTimeline(path = join(__dirname, '..', 'timeline.json')): Timeline {
  const raw = readFileSync(resolve(path), 'utf-8');
  return parseTimeline(JSON.parse(raw));
}

/** Total runtime of the demo in seconds. */
export function totalDuration(timeline: Timeline): number {
  return timeline.steps.reduce((sum, s) => sum + s.durationSeconds, 0);
}

/** Cumulative start time (seconds) for each step, in declaration order. */
export function stepStartTimes(timeline: Timeline): Record<string, number> {
  let t = 0;
  const out: Record<string, number> = {};
  for (const s of timeline.steps) {
    out[s.id] = t;
    t += s.durationSeconds;
  }
  return out;
}
