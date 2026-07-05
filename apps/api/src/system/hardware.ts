/**
 * Server-side hardware detection + hardware-aware local-model recommendation.
 *
 * The point: a non-technical user should NEVER have to pick a model or read a
 * RAM chart. The app looks at the actual machine (RAM + free disk + whether a
 * llama.cpp binary is present) and picks the best local model that will really
 * run — and, critically, that will actually fit on disk. Everything degrades
 * gracefully: if we can't read a value we fall back to a conservative default
 * rather than recommending something that won't run.
 *
 * Reuses the curated catalog in `@skytwin/embedded-llm` (MODEL_REGISTRY) so the
 * sizes/quality scores stay in one place.
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { MODEL_REGISTRY, type ModelEntry, type RamBracket } from '@skytwin/embedded-llm';

export interface HardwareProfile {
  /** Total physical RAM, GB (rounded). */
  ramGB: number;
  /** Free space on the volume that holds the model dir, GB (rounded). null if unknown. */
  freeDiskGB: number | null;
  cpuCores: number;
  arch: string;
  platform: string;
  /** True if a llama.cpp CLI binary is resolvable (env or PATH) — needed to actually run a model. */
  hasLlamaBinary: boolean;
  /** RAM bracket used to size the model recommendation. */
  ramBracket: RamBracket;
}

export interface LocalModelRecommendation {
  /** The recommended model, or null when nothing fits (e.g. not enough disk). */
  model: ModelEntry | null;
  /** Human, non-technical explanation of the pick (or why there isn't one). */
  reason: string;
  /** True when the recommended model fits free disk with headroom. */
  fitsDisk: boolean;
  /** Approx download size in GB for the recommendation (convenience for the UI). */
  downloadGB: number | null;
  hardware: HardwareProfile;
}

const GB = 1024 * 1024 * 1024;
/** Keep this much disk free after the model lands (temp files, OS breathing room). */
const DISK_HEADROOM_GB = 3;

function bracketFromRamGB(ramGB: number): RamBracket {
  if (ramGB < 6) return '4gb';
  if (ramGB < 12) return '8gb';
  if (ramGB < 24) return '16gb';
  return '32gb-plus';
}

/** Numeric rank so we can compare "does this model's RAM need fit this machine". */
function bracketRank(b: RamBracket): number {
  switch (b) {
    case '4gb': return 4;
    case '8gb': return 8;
    case '16gb': return 16;
    case '32gb-plus': return 32;
  }
}

/** Best-effort free-disk read for the directory that will hold models. */
function freeDiskGBFor(dir: string): number | null {
  // Walk up to the first existing ancestor (the model dir may not exist yet).
  let probe = dir;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(probe)) break;
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const stat = fs.statfsSync(probe);
    const freeBytes = stat.bavail * stat.bsize;
    return Math.round(freeBytes / GB);
  } catch {
    return null;
  }
}

/** Where downloaded GGUF models live (mirrors the downloader's resolveModelDir). */
function modelDir(): string {
  return process.env['SKYTWIN_LLAMA_MODELS'] ?? path.join(os.homedir(), '.skytwin', 'models', 'llama');
}

/** True if a llama.cpp CLI binary is resolvable via env or on PATH. Never throws. */
export function hasLlamaBinary(): boolean {
  const envBin = process.env['SKYTWIN_LLAMACPP_BIN'];
  if (envBin && fs.existsSync(envBin)) return true;
  const names = process.platform === 'win32' ? ['llama-cli.exe', 'llama.exe'] : ['llama-cli', 'llama'];
  const pathDirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of names) {
      try {
        if (fs.existsSync(path.join(dir, name))) return true;
      } catch {
        /* ignore unreadable PATH entry */
      }
    }
  }
  return false;
}

/** Detect the machine's hardware profile. Pure reads; never throws. */
export function detectHardware(): HardwareProfile {
  const ramGB = Math.round(os.totalmem() / GB);
  return {
    ramGB,
    freeDiskGB: freeDiskGBFor(modelDir()),
    cpuCores: os.cpus().length,
    arch: os.arch(),
    platform: os.platform(),
    hasLlamaBinary: hasLlamaBinary(),
    ramBracket: bracketFromRamGB(ramGB),
  };
}

/**
 * Pick the best local model for this machine: the highest-quality catalog model
 * whose RAM requirement fits the machine AND whose download fits free disk with
 * headroom. Steps down to a smaller model when disk is tight, and returns a
 * null model (with a clear reason) when nothing fits.
 */
export function recommendLocalModel(hw: HardwareProfile = detectHardware()): LocalModelRecommendation {
  const machineRank = bracketRank(hw.ramBracket);
  // RAM-fitting models, best quality first.
  const ramFits = MODEL_REGISTRY
    .filter((m) => bracketRank(m.ramBracket) <= machineRank)
    .slice()
    .sort((a, b) => b.qualityScore - a.qualityScore);

  const diskGB = hw.freeDiskGB;
  const fitsDisk = (m: ModelEntry): boolean =>
    diskGB === null ? true : m.approxBytes / GB + DISK_HEADROOM_GB <= diskGB;

  const pick = ramFits.find(fitsDisk) ?? null;

  if (!pick) {
    // Either nothing matches RAM (shouldn't happen — 4gb model exists) or disk is too tight.
    const smallest = [...MODEL_REGISTRY].sort((a, b) => a.approxBytes - b.approxBytes)[0];
    const needGB = smallest ? Math.ceil(smallest.approxBytes / GB + DISK_HEADROOM_GB) : null;
    return {
      model: null,
      fitsDisk: false,
      downloadGB: null,
      reason:
        diskGB !== null && needGB !== null
          ? `Not enough free disk to install a local model — you have about ${diskGB} GB free and the smallest model needs about ${needGB} GB. Free up some space, or use a cloud API key instead.`
          : 'Could not find a local model that fits this computer. You can use a cloud API key instead.',
      hardware: hw,
    };
  }

  const downloadGB = Math.round((pick.approxBytes / GB) * 10) / 10;
  const steppedDown = ramFits[0] && ramFits[0].id !== pick.id;
  const reason = steppedDown
    ? `Best model that fits your free disk: ${pick.displayName} (~${downloadGB} GB). A larger model would run on your ${hw.ramGB} GB of RAM, but wouldn't fit the disk space you have right now.`
    : `Best model for your computer: ${pick.displayName} (~${downloadGB} GB) — sized for your ${hw.ramGB} GB of RAM${diskGB !== null ? ` and ${diskGB} GB free disk` : ''}. Runs entirely on your machine, no account or API key needed.`;

  return { model: pick, fitsDisk: diskGB === null ? true : fitsDisk(pick), downloadGB, reason, hardware: hw };
}
