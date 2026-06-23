// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('global layout guardrails', () => {
  it('keeps the global pause control out of the document flex flow', () => {
    expect(source).toMatch(/\.global-pause-mount\s*{[^}]*position:\s*fixed;/s);
    expect(source).toMatch(/\.global-pause-mount\s*{[^}]*right:\s*1rem;/s);
  });

  it('wraps long inline code and constrains pre blocks on mobile', () => {
    expect(source).toMatch(/code\s*{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(source).toMatch(/pre\s*{[^}]*max-width:\s*100%;/s);
  });
});
