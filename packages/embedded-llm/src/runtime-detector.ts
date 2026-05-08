import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Capability information for a single embedded runtime.
 */
export interface EmbeddedRuntimeEntry {
  available: boolean;
  binaryPath: string | null;
  modelDir: string | null;
}

/**
 * Aggregated detection result for all supported embedded runtimes.
 */
export interface EmbeddedRuntimeInfo {
  llamaCpp: EmbeddedRuntimeEntry;
  whisper: EmbeddedRuntimeEntry;
  piper: EmbeddedRuntimeEntry;
}

/**
 * Resolves the binary path for a given CLI name, preferring an explicit env-var
 * override. Returns null when neither the env var nor PATH lookup finds it.
 *
 * IMPORTANT: this function only checks for existence — it never spawns the binary.
 */
function resolveBinary(envVar: string, cliName: string): string | null {
  const fromEnv = process.env[envVar];
  if (fromEnv !== undefined && fromEnv !== '') {
    return existsSync(fromEnv) ? fromEnv : null;
  }

  // Fall back to `which` (Unix) / `where` (Windows) for PATH lookup.
  const cmd = process.platform === 'win32' ? `where ${cliName}` : `which ${cliName}`;
  try {
    const result = execSync(cmd, { stdio: 'pipe', timeout: 3000 })
      .toString()
      .trim()
      .split('\n')[0];
    return result !== undefined && result !== '' ? result : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the model directory from an env var. Returns null when the var is
 * unset or empty. Existence of the directory is not verified because the
 * directory may be created lazily by the actual integration.
 */
function resolveModelDir(envVar: string): string | null {
  const value = process.env[envVar];
  return value !== undefined && value !== '' ? value : null;
}

/**
 * Detects which embedded runtimes are available on the current machine.
 *
 * Detection strategy (per runtime):
 *   1. If the corresponding SKYTWIN_*_BIN env var is set, use that path
 *      (existence-checked via fs.existsSync).
 *   2. Otherwise, run `which <cli>` (or `where` on Windows) to locate the
 *      binary in PATH.
 *   3. Model directories are taken from SKYTWIN_LLAMA_MODELS,
 *      SKYTWIN_WHISPER_MODELS, and SKYTWIN_PIPER_MODELS env vars.
 *
 * Returns a Promise so future implementations can perform async detection
 * (e.g. probing a socket) without breaking the contract.
 */
export async function detectEmbeddedRuntimes(): Promise<EmbeddedRuntimeInfo> {
  const llamaBin = resolveBinary('SKYTWIN_LLAMACPP_BIN', 'llama-cli');
  const whisperBin = resolveBinary('SKYTWIN_WHISPER_BIN', 'whisper-cli');
  const piperBin = resolveBinary('SKYTWIN_PIPER_BIN', 'piper');

  return {
    llamaCpp: {
      available: llamaBin !== null,
      binaryPath: llamaBin,
      modelDir: resolveModelDir('SKYTWIN_LLAMA_MODELS'),
    },
    whisper: {
      available: whisperBin !== null,
      binaryPath: whisperBin,
      modelDir: resolveModelDir('SKYTWIN_WHISPER_MODELS'),
    },
    piper: {
      available: piperBin !== null,
      binaryPath: piperBin,
      modelDir: resolveModelDir('SKYTWIN_PIPER_MODELS'),
    },
  };
}
