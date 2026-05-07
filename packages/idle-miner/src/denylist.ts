/**
 * Hard denylist for the idle filesystem miner.
 *
 * COMPILE-TIME CONSTANT. NOT configurable from runtime. Adding entries
 * is a PR. See docs/architecture-philosophy.md "What never moves".
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

export const FS_DENYLIST_PATHS: readonly string[] = Object.freeze([
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.kube',
  '~/Library/Keychains',
  '~/Library/Cookies',
  '~/Library/Application Support/Google/Chrome/Default/Cookies',
  '~/Library/Application Support/Firefox/Profiles',
  '~/Library/Application Support/1Password',
  '~/Library/Application Support/Bitwarden',
  '~/.password-store',
]);

export const FS_DENYLIST_PATTERNS: readonly RegExp[] = Object.freeze([
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa(\.|$)/,
  /(^|\/)id_ed25519(\.|$)/,
  /(^|\/)id_ecdsa(\.|$)/,
  /(^|\/)credentials(\.|$)/,
  /(^|\/)\.env(\.|$)/,
  /\.kdbx$/i,
  /\.gpg$/i,
  /\.asc$/i,
]);

function expandPath(p: string, homedir: string): string {
  if (p.startsWith('~/')) {
    return join(homedir, p.slice(2));
  }
  if (p === '~') {
    return homedir;
  }
  return p;
}

function resolveRealPath(absPath: string): string | null {
  try {
    return realpathSync(absPath);
  } catch {
    return null;
  }
}

export interface IsDeniedOptions {
  /** Override realpathSync for testing. Returns null if path does not exist. */
  realpathFn?: (p: string) => string | null;
}

export function isDenied(
  absPath: string,
  homedir: string,
  options: IsDeniedOptions = {},
): boolean {
  const realpath = options.realpathFn ?? resolveRealPath;

  // Expand denylist paths to absolute
  const deniedAbsPaths = FS_DENYLIST_PATHS.map((p) => expandPath(p, homedir));

  // Check if absPath or any prefix matches a denylist path
  function pathMatchesDenyDir(target: string): boolean {
    for (const denied of deniedAbsPaths) {
      if (target === denied || target.startsWith(denied + '/') || target.startsWith(denied + '\\')) {
        return true;
      }
    }
    return false;
  }

  // Check pattern denylist against the basename / full path
  function pathMatchesDenyPattern(target: string): boolean {
    const normalized = target.replace(/\\/g, '/');
    for (const pattern of FS_DENYLIST_PATTERNS) {
      if (pattern.test(normalized)) {
        return true;
      }
    }
    return false;
  }

  if (pathMatchesDenyDir(absPath) || pathMatchesDenyPattern(absPath)) {
    return true;
  }

  // Resolve symlinks and re-check
  const resolved = realpath(absPath);
  if (resolved !== null && resolved !== absPath) {
    if (pathMatchesDenyDir(resolved) || pathMatchesDenyPattern(resolved)) {
      return true;
    }
  }

  return false;
}
