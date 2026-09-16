import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Detects whether the `gbrain` CLI is present in PATH.
 *
 * Uses `which` on Unix-like systems and `where` on Windows. Returns false on
 * any error (not found, permission denied, timeout) so callers can fall back
 * gracefully without throwing.
 */
export function isGbrainInstalled(): boolean {
  const cmd = process.platform === 'win32' ? 'where gbrain' : 'which gbrain';
  try {
    execSync(cmd, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect whether the user has an existing gbrain configuration directory.
 * Current upstream gbrain uses `~/.gbrain/`; `~/.config/gbrain/` is retained
 * for compatibility with older installations. This is an informational signal
 * only: SkyTwin never treats directory presence as permission to read or import
 * that separate brain.
 *
 * Issue #197 AC #7 — opt-in surfacing.
 */
export function hasExternalGbrainConfig(): boolean {
  try {
    const home = homedir();
    return (
      existsSync(join(home, '.config', 'gbrain')) ||
      existsSync(join(home, '.gbrain'))
    );
  } catch {
    return false;
  }
}
