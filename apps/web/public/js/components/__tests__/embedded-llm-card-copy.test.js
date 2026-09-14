// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../embedded-llm-card.js', import.meta.url),
  'utf8',
);

describe('local model delivery copy', () => {
  it('labels completion as verified artifact state, not runtime readiness', () => {
    expect(source).toContain('Local model artifact verified');
    expect(source).toContain(
      'a compatible llama.cpp runtime is still required for local inference',
    );
    expect(source).not.toContain("Your twin's brain is installed");
    expect(source).not.toContain('ready for local use');
  });

  it('states that downloading the artifact does not install the runtime', () => {
    expect(source).toContain(
      'Downloading the artifact does not install the runtime.',
    );
    expect(source).not.toContain(
      'Your twin works fully offline once a brain is installed.',
    );
  });
});
