import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), 'public');
const onboarding = fs.readFileSync(path.join(root, 'js/pages/onboarding.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

describe('onboarding accessibility contract', () => {
  it('keeps a labelled modal dialog and live busy/status regions', () => {
    expect(index).toContain('role="dialog" aria-modal="true" aria-labelledby="onb-dialog-title"');
    expect(index).toContain('id="onboarding-content" aria-busy="false"');
    expect(index).toContain('id="onb-wizard-status" role="status" aria-live="polite"');
    expect(onboarding).toContain("el.setAttribute('aria-busy', 'true')");
    expect(onboarding).toContain("el.setAttribute('aria-busy', 'false')");
  });

  it('gives every onboarding action button an explicit non-submit type', () => {
    const buttons = [...onboarding.matchAll(/<button\b[^>]*>/g)].map(([tag]) => tag);
    expect(buttons.length).toBeGreaterThan(10);
    expect(buttons.every((tag) => /\btype="button"/.test(tag))).toBe(true);
  });

  it('keeps form controls explicitly labelled and error announcements assertive', () => {
    expect(onboarding).toContain('for="onb-name-input"');
    expect(onboarding).toContain('for="onb-email-input"');
    expect(onboarding).toContain('for="onb-chat-input"');
    expect(onboarding).toContain("el.setAttribute('role', 'alert')");
  });

  it('preserves delegated actions and the default sample path', () => {
    expect(onboarding).toContain('document.addEventListener(\'click\', handleOnboardingClick)');
    expect(onboarding).toContain('Just show me around');
    expect(onboarding).toContain('data-action="onb-start-tour"');
  });
});
