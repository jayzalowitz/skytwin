import { statSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_ALLOWLIST_RELATIVE: readonly string[] = Object.freeze([
  'Documents',
  'Downloads',
  'Desktop',
  'Projects',
  'Code',
  'dev',
  'src',
]);

export function expandAllowlist(homedir: string): string[] {
  const result: string[] = [];
  for (const rel of DEFAULT_ALLOWLIST_RELATIVE) {
    const abs = join(homedir, rel);
    try {
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        result.push(abs);
      }
    } catch {
      // Directory doesn't exist — skip silently
    }
  }
  return result;
}
