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
    expect(onboarding).toContain("renderContent(html, { busy = false, status = '' } = {})");
    expect(onboarding).toContain("setWizardBusy(false, 'Onboarding options ready.', generation)");
    expect(onboarding).toContain("status: 'Scanning for project signals…'");
    expect(onboarding).toContain('let _renderGeneration = 0');
    expect(onboarding).toContain('let _wizardRunGeneration = 0');
    expect(onboarding).toContain('if (!isCurrentWizardRun(runGeneration)) return');
    expect(onboarding).toContain('const runGeneration = ++_wizardRunGeneration');
    expect(onboarding).toContain('_wizardRunGeneration += 1');
    expect(onboarding).toContain('export function invalidateOnboardingRun()');
    expect(onboarding).toContain('if (!isCurrentWizardRun(runGeneration)) return;');
    expect(onboarding).toContain('if (generation !== _renderGeneration) return');
    expect(onboarding).toContain("setWizardBusy(true, 'Loading your first question…')");
    expect(onboarding).toContain('const runGeneration = _wizardRunGeneration');
    expect(onboarding).toContain('if (isCurrentWizardRun(runGeneration)) handleFinalFromHistory()');
    expect(onboarding).toContain('const result = await postDeterministicPick(userId, _detAnswers);');
    expect(onboarding).toContain('if (!isCurrentWizardRun(runGeneration)) return;');
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

  it('contains keyboard focus only while the visible dialog is active', () => {
    const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
    expect(app).toContain('function handleOnboardingKeydown(e)');
    expect(app).toContain("e.key !== 'Tab'");
    expect(app).toContain("document.addEventListener('keydown', handleOnboardingKeydown)");
    expect(app).toContain("document.removeEventListener('keydown', handleOnboardingKeydown)");
    expect(app).toContain("overlay.style.display === 'none'");
    expect(app).toContain('window.skyTwinCancelOnboarding()');
    expect(app).toContain("document.activeElement?.getAttribute('tabindex') === '-1'");
  });

  it('guards side-effecting async continuations and delayed fallback work', () => {
    expect(onboarding).toContain('const runGeneration = _wizardRunGeneration;');
    expect(onboarding).toContain('const result = await createUser(email, name, \'suggest\');');
    expect(onboarding).toContain('await postOnboardingComplete(userId || getCurrentUserId(), \'computer\');');
    expect(onboarding).toContain('const session = await startDemoSession();');
    expect(onboarding).toContain('await postDeterministicPick(userId, _detAnswers);');
    expect(onboarding).toContain('await postOnboardingComplete(userId, choice, recipeSlug);');
    expect(onboarding).toContain('if (isCurrentWizardRun(runGeneration)) handleFinalFromHistory()');
    expect(onboarding).toContain('if (!isCurrentWizardRun(runGeneration)) return;');
  });
});
