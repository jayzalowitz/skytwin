// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions (same pattern as memory-settings.test.js) guarding the
// source-attribution footer's invariants: no internal jargon leaks, untrusted
// metadata is escaped, and no inline event handlers are introduced.
const assistantSource = readFileSync(new URL('./assistant.js', import.meta.url), 'utf8');
const onboardingSource = readFileSync(new URL('./onboarding.js', import.meta.url), 'utf8');

describe('assistant source-attribution footer', () => {
  it('maps the origin slugs gbrain/the API actually emit', () => {
    // gbrain emits signal/extract/episode; the API labels past decisions
    // 'decision'. All must have a plain-language mapping.
    for (const slug of ['signal', 'extract', 'episode', 'decision', 'gmail', 'calendar']) {
      expect(assistantSource).toMatch(new RegExp(`${slug}:\\s*'`));
    }
  });

  it('never falls back to a raw/title-cased slug (human-meaningful-presentation rule)', () => {
    // The fallback must be the generic safe label, not a title-cased slug.
    expect(assistantSource).toContain("return SOURCE_LABELS[source] || 'your memory';");
    expect(assistantSource).not.toContain('source.charAt(0).toUpperCase()');
  });

  it('escapes the untrusted source label + origin before rendering', () => {
    // sources come from persisted message metadata — treat as untrusted.
    expect(assistantSource).toContain('escapeHtml(typeof s?.label');
    expect(assistantSource).toContain('escapeHtml(prettySource(s?.source))');
  });

  it('only renders the footer for assistant messages with sources', () => {
    expect(assistantSource).toContain("role === 'assistant' && sources.length");
  });

  it('introduces no inline event handlers in the footer markup', () => {
    expect(assistantSource).not.toMatch(/<[^>]*\son(click|keydown|keyup|change|input|submit)=/i);
  });
});

describe('onboarding capability copy', () => {
  it('does not claim screen / app / window / browser observation it cannot do', () => {
    expect(onboardingSource).not.toContain('watching which apps you use');
    expect(onboardingSource).not.toContain('which apps and files you use');
    expect(onboardingSource).not.toContain('Active application names');
    expect(onboardingSource).not.toContain('Window titles');
    expect(onboardingSource).not.toContain('Browser domain names');
    expect(onboardingSource).not.toContain('first app signal');
  });

  it('describes the project-metadata scan it actually performs', () => {
    expect(onboardingSource).toContain('scanning your code projects');
    expect(onboardingSource).toContain('project metadata only');
  });
});
