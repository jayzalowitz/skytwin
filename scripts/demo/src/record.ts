/**
 * Demo recorder entry point (#414).
 *
 *   1. Load + validate `timeline.json`.
 *   2. Pre-flight: confirm the dev server is reachable + the sample
 *      profile is seeded. We DON'T pre-flight Piper here — the
 *      synthesize step will fail loud with a useful hint if piper-cli
 *      isn't installed.
 *   3. Boot a Playwright Chromium with the timeline's viewport.
 *      Pre-seed localStorage with the sample userId so the wizard's
 *      "Try with a sample profile" path is one click instead of a
 *      multi-step setup.
 *   4. Walk the timeline. For each step: run its actions, then sleep
 *      until the step's wall-clock duration elapses. A background
 *      loop captures `page.screenshot()` at `timeline.fps` the whole
 *      time. Filenames are `frame-NNNNNN.png` zero-padded so ffmpeg's
 *      glob picks them up in order.
 *   5. Pre-synthesise every narration line via Piper (sha256-cached).
 *   6. Hand off to `assemble.ts` for the ffmpeg mux.
 *
 * No retries, no flake-tolerance. If a step's selector doesn't
 * resolve, the recorder fails loud — we'd rather the user re-run
 * than ship a broken video. Playwright's default timeouts already
 * give selectors generous breathing room.
 *
 * Environment knobs:
 *   SKYTWIN_WEB_BASE   default http://localhost:3200 — the web app
 *   SKYTWIN_API_BASE   default http://localhost:3100 — the API
 *   SKYTWIN_DEMO_USER_ID  default 'demo-user' — used for Piper auth
 */

import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { chromium } from '@playwright/test';
import type { StepAction, Timeline, TimelineStep } from './timeline.js';
import { loadTimeline, totalDuration } from './timeline.js';
import { synthesizeAll } from './narrator.js';
import { assemble } from './assemble.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(PKG_ROOT, 'out');
const FRAMES_DIR = resolve(OUT_DIR, 'frames');
const NARRATION_DIR = resolve(OUT_DIR, 'narration-cache');
const OUTPUT_MP4 = resolve(OUT_DIR, 'demo.mp4');

const WEB_BASE = (process.env['SKYTWIN_WEB_BASE'] ?? 'http://localhost:3200').replace(/\/+$/, '');
const API_BASE = (process.env['SKYTWIN_API_BASE'] ?? 'http://localhost:3100').replace(/\/+$/, '');

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[demo-recorder] ${msg}`);
}

async function preflight(): Promise<{ sampleUserId: string }> {
  // Web reachable?
  try {
    const res = await fetch(`${WEB_BASE}/`, { method: 'HEAD' });
    if (!res.ok && res.status !== 304) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    throw new Error(
      `Web app not reachable at ${WEB_BASE}. Start it with \`pnpm dev\` from the` +
      ` repo root before running the recorder. (cause: ${(err as Error).message})`,
    );
  }
  // Demo seed loaded?
  let payload: { available?: boolean; userId?: string };
  try {
    const res = await fetch(`${API_BASE}/api/v1/demo/info`);
    payload = await res.json();
  } catch (err) {
    throw new Error(
      `API not reachable at ${API_BASE}/api/v1/demo/info. Same fix:` +
      ` start the dev server. (cause: ${(err as Error).message})`,
    );
  }
  if (!payload.available || typeof payload.userId !== 'string' || payload.userId.length === 0) {
    throw new Error(
      `Sample profile not loaded. Run \`pnpm db:seed\` from the repo root` +
      ` (see docs/demo.md "Before you start"). The recorder needs the sample` +
      ` user to have a deterministic dashboard to record against.`,
    );
  }
  return { sampleUserId: payload.userId };
}

async function applyAction(page: Page, action: StepAction): Promise<void> {
  switch (action.kind) {
    case 'goto': {
      const url = action.url.startsWith('http') ? action.url : `${WEB_BASE}${action.url}`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      break;
    }
    case 'click':
      await page.click(action.selector);
      break;
    case 'waitForSelector':
      await page.waitForSelector(action.selector, { state: 'visible' });
      break;
    case 'waitForUrl':
      await page.waitForURL((u) => u.toString().includes(action.pattern));
      break;
    case 'scroll-to':
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el instanceof HTMLElement) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, action.selector);
      break;
    case 'screenshot-hold':
      // Intentional no-op — the capture loop is doing the work; this
      // marker just means "stay on the current view for this step's
      // duration without doing anything else."
      break;
  }
}

async function runStepActions(page: Page, step: TimelineStep): Promise<void> {
  for (const action of step.actions) {
    await applyAction(page, action);
  }
}

function frameFilename(idx: number): string {
  return `frame-${String(idx).padStart(6, '0')}.png`;
}

async function captureLoop(opts: {
  page: Page;
  framesDir: string;
  fps: number;
  durationSeconds: number;
}): Promise<number> {
  const intervalMs = Math.round(1000 / opts.fps);
  const totalFrames = Math.round(opts.durationSeconds * opts.fps);
  let captured = 0;
  for (let i = 0; i < totalFrames; i++) {
    const start = Date.now();
    try {
      await opts.page.screenshot({
        path: join(opts.framesDir, frameFilename(captured)),
        type: 'png',
        fullPage: false,
      });
      captured++;
    } catch {
      // If the page is mid-navigation the screenshot can briefly
      // fail. We swallow it — the next tick recovers — but log it so
      // a string of failures is at least visible.
      log(`screenshot at frame ${captured} failed (continuing)`);
    }
    const elapsed = Date.now() - start;
    const sleep = intervalMs - elapsed;
    if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
  }
  return captured;
}

async function runRecording(timeline: Timeline): Promise<void> {
  log(`Pre-flighting against ${WEB_BASE} + ${API_BASE} …`);
  const { sampleUserId } = await preflight();
  log(`Sample profile: ${sampleUserId}`);

  // Reset the output dirs so each run starts clean. The narration
  // cache lives elsewhere — those WAVs are reusable across runs.
  rmSync(FRAMES_DIR, { recursive: true, force: true });
  mkdirSync(FRAMES_DIR, { recursive: true });

  log('Launching Playwright Chromium …');
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: timeline.viewport,
      deviceScaleFactor: 1,
      // Pin a stable user-agent — same content, same screenshots,
      // even if Playwright/Chromium bumps a minor in CI.
      userAgent: 'SkyTwin-DemoRecorder/0.1 (Playwright/Chromium)',
    });
    // Pre-seed localStorage so the wizard's "Try with a sample
    // profile" choice is one click instead of a full multi-step
    // dance. The keys mirror what `onb-start-tour` writes on click
    // (see apps/web/public/js/pages/onboarding.js).
    await context.addInitScript(
      ({ uid }) => {
        try {
          localStorage.setItem('skytwin_userId', uid);
          // Tour mode lets the chrome render the sample-profile copy
          // variant; KEY_ONBOARDED='sample' takes the user out of
          // the first-run-wizard branch on every subsequent boot.
        } catch { /* private mode */ }
      },
      { uid: sampleUserId },
    );
    const page = await context.newPage();

    log(`Walking ${timeline.steps.length} steps (~${totalDuration(timeline)}s end-to-end) …`);
    let captured = 0;
    for (const step of timeline.steps) {
      log(`  · ${step.id} (${step.durationSeconds}s)`);
      const actionPromise = runStepActions(page, step);
      const captureFrames = captureLoop({
        page,
        framesDir: FRAMES_DIR,
        fps: timeline.fps,
        durationSeconds: step.durationSeconds,
      });
      const [, framesThisStep] = await Promise.all([actionPromise, captureFrames]);
      captured += framesThisStep;
    }
    log(`Captured ${captured} frames into ${FRAMES_DIR}`);
  } finally {
    await browser.close();
  }

  log('Synthesising narration via Piper TTS …');
  const narration = await synthesizeAll({
    timeline,
    cacheDir: NARRATION_DIR,
    apiBase: API_BASE,
  });
  log(
    `Narration ready (${narration.filter((n) => n.fromCache).length}/${narration.length}` +
    ` from cache).`,
  );

  log(`Assembling ${OUTPUT_MP4} via ffmpeg …`);
  await assemble({
    timeline,
    framesDir: FRAMES_DIR,
    narration,
    outputPath: OUTPUT_MP4,
  });
  log(`Done. Output: ${OUTPUT_MP4}`);
}

async function main(): Promise<void> {
  const timeline = loadTimeline();
  await runRecording(timeline);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`\n[demo-recorder] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
