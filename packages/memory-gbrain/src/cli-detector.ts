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
 * The presence of `~/.config/gbrain/` (or `~/.gbrain/` on older installs) is
 * the signal SkyTwin uses to surface the "your twin can use your existing
 * brain" hybrid-mode prompt.
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
