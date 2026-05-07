import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LoadedPrompt } from './types.js';
import { loadPrompt } from './prompt-loader.js';

interface OverrideEntry {
  prompt: LoadedPrompt;
  mtimeMs: number;
}

const overrideCache = new Map<string, OverrideEntry>();

function overridePath(name: string): string {
  return join(homedir(), '.config', 'skytwin', 'prompts', `${name}.md`);
}

function currentMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return -1;
  }
}

function parseOverrideFile(filePath: string, name: string): LoadedPrompt | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    // Reuse the bundled prompt-loader's frontmatter logic but inline here
    // by loading a temporary synthetic prompt. We parse it manually to avoid
    // circular module dependencies during the fallback path.
    const trimmed = content.trimStart();
    if (!trimmed.startsWith('---')) return null;
    const end = trimmed.indexOf('---', 3);
    if (end === -1) return null;

    return {
      meta: { name, version: 1 },
      templateBody: trimmed.slice(end + 3).trimStart(),
      fixtures: [],
      schema: undefined,
    };
  } catch {
    return null;
  }
}

export function loadPromptWithOverride(name: string, version?: number): LoadedPrompt {
  const filePath = overridePath(name);

  if (!existsSync(filePath)) {
    overrideCache.delete(name);
    return loadPrompt(name, version);
  }

  const mtime = currentMtime(filePath);
  const cached = overrideCache.get(name);

  if (cached && cached.mtimeMs === mtime) {
    return cached.prompt;
  }

  const override = parseOverrideFile(filePath, name);
  if (override === null) {
    return loadPrompt(name, version);
  }

  overrideCache.set(name, { prompt: override, mtimeMs: mtime });
  return override;
}

export function clearOverrideCache(): void {
  overrideCache.clear();
}
