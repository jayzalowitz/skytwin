import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// vi.hoisted ensures the ref exists at the top of the file before vi.mock
// runs (vi.mock is itself hoisted by Vitest above all imports/decls).
const tmpHomeRef = vi.hoisted(() => ({ value: '' }));

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, homedir: () => tmpHomeRef.value };
});

describe('override', () => {
  let overrideDir: string;

  beforeEach(() => {
    tmpHomeRef.value = join(
      tmpdir(),
      `skytwin-override-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    overrideDir = join(tmpHomeRef.value, '.config', 'skytwin', 'prompts');
    mkdirSync(overrideDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpHomeRef.value, { recursive: true, force: true });
  });

  it('falls back to bundled prompt when no override file exists', async () => {
    const { loadPromptWithOverride } = await import('../override.js');
    const result = loadPromptWithOverride('service-detection');
    expect(result.meta.name).toBe('service-detection');
    expect(result.fixtures.length).toBeGreaterThan(0);
  });

  it('loads user override when override file exists', async () => {
    const overrideContent = `---
name: service-detection
version: 2
---

# System
Custom override prompt body.

# User
{{signals}}
`;
    writeFileSync(join(overrideDir, 'service-detection.md'), overrideContent);
    const { loadPromptWithOverride, clearOverrideCache } = await import('../override.js');
    clearOverrideCache();

    const result = loadPromptWithOverride('service-detection');
    expect(result.templateBody).toContain('Custom override prompt body');
  });

  it('falls back to bundled prompt when override file is malformed', async () => {
    writeFileSync(join(overrideDir, 'service-detection.md'), 'no frontmatter at all, just raw text without --- markers');
    const { loadPromptWithOverride, clearOverrideCache } = await import('../override.js');
    clearOverrideCache();

    const result = loadPromptWithOverride('service-detection');
    // Malformed (no --- delimiters) falls back to bundled
    expect(result.fixtures.length).toBeGreaterThan(0);
  });

  it('reloads when file mtime changes', async () => {
    const v1Content = `---
name: service-detection
version: 1
---

# System
Version one.
`;
    const overridePath = join(overrideDir, 'service-detection.md');
    writeFileSync(overridePath, v1Content);

    const { loadPromptWithOverride, clearOverrideCache } = await import('../override.js');
    clearOverrideCache();

    const first = loadPromptWithOverride('service-detection');
    expect(first.templateBody).toContain('Version one');

    const v2Content = `---
name: service-detection
version: 1
---

# System
Version two.
`;
    writeFileSync(overridePath, v2Content);
    // Force a mtime change by setting it one second in the future
    const futureTime = new Date(Date.now() + 1000);
    utimesSync(overridePath, futureTime, futureTime);

    const second = loadPromptWithOverride('service-detection');
    expect(second.templateBody).toContain('Version two');
  });
});
