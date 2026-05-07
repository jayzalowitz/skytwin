import { execSync } from 'node:child_process';

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
