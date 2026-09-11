// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  KEY_ONBOARDED,
  KEY_ONBOARDING_REASONING_CHOICE,
  KEY_ONBOARDING_RETURN_HASH,
  KEY_SESSION_TOKEN,
  KEY_USER_ID,
  ONBOARDING_STATE_VERSION,
} from '../storage-keys.js';
import {
  applyPendingReasoningChoice,
  completePendingGoogleOnboarding,
  consumeOnboardingReturnHash,
  focusOnboardingContent,
  initialOnboardingState,
  parseOnboardingResumeState,
  rememberOnboardingReturnHash,
  renderAutonomyScreen,
  renderCompleteScreen,
  renderDataSourceScreen,
  renderErrorScreen,
  renderReasoningScreen,
} from './onboarding.js';
function tags(html) {
  return html.match(/<[^>]+>/g) || [];
}

describe('briefing-first onboarding', () => {
  it('presents exactly the three requested decisions with native radio groups', () => {
    const data = renderDataSourceScreen(initialOnboardingState());
    const reasoning = renderReasoningScreen({ ...initialOnboardingState(), dataSource: 'connect' });
    const autonomy = renderAutonomyScreen({ ...initialOnboardingState(), dataSource: 'connect' });
    expect(data).toContain('Step 1 of 3');
    expect(data).toContain('name="data-source"');
    expect(data).toContain('Sign in with Google first');
    expect(data).not.toContain('type="email"');
    expect(reasoning).toContain('Step 2 of 3');
    expect(reasoning).toContain('name="reasoning-mode"');
    expect(autonomy).toContain('Step 3 of 3');
    expect(autonomy).toContain('name="autonomy"');
  });

  it('keeps the sample boundary fixed and explicit', () => {
    const html = renderReasoningScreen({ ...initialOnboardingState(), dataSource: 'sample' });
    expect(html).toContain('Deterministic sample');
    expect(html).toContain('No provider request');
    expect(html).toContain('External inference');
    expect(html).toContain('>None<');
    expect(html).not.toContain('name="reasoning-mode"');
  });

  it('shows unavailable modes and an accurate conventional-provider disclosure', () => {
    const html = renderReasoningScreen({
      ...initialOnboardingState(),
      dataSource: 'connect',
      reasoningMode: 'bring_your_own_provider',
    });
    expect(html).toContain('On this device — unavailable');
    expect(html).toContain('Verified private cloud — unavailable');
    expect(html.match(/ disabled/g)).toHaveLength(2);
    expect(html).toContain('external network connection');
    expect(html).toContain("provider's retention terms");
    expect(html).toContain('No confidential-computing guarantee');
    expect(html).toContain('setup preference');
    expect(html).toContain('preview makes no settings change');
  });

  it('makes observer the only active authority and names the write boundary', () => {
    const html = renderAutonomyScreen({ ...initialOnboardingState(), dataSource: 'connect' });
    expect(html).toContain('value="observer" checked');
    expect(html).toContain('Just watch');
    expect(html).toContain('Writes allowed: no');
    expect(html).not.toContain('value="suggest"');
  });

  it('reviews sample facts and targets the briefing', () => {
    const html = renderCompleteScreen({ ...initialOnboardingState(), dataSource: 'sample' });
    expect(html).toContain('Fictional packaged sample');
    expect(html).toContain('No external inference or provider request');
    expect(html).toContain('No write or execution authority');
    expect(html).toContain('Open sample briefing');
  });

  it('renders a contained retry state', () => {
    const html = renderErrorScreen('<network failed>');
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-action="onb-retry"');
    expect(html).toContain('&lt;network failed&gt;');
  });

  it('resumes only valid versioned decision state', () => {
    const valid = parseOnboardingResumeState(JSON.stringify({
      v: ONBOARDING_STATE_VERSION,
      screen: 'autonomy',
      dataSource: 'connect',
      reasoningMode: 'not_configured',
      apiKey: 'must-not-survive',
    }), 'user-1');
    expect(valid).toMatchObject({
      screen: 'autonomy',
      dataSource: 'connect',
      reasoningMode: 'not_configured',
      autonomy: 'observer',
      userId: 'user-1',
    });
    expect(valid).not.toHaveProperty('apiKey');
    expect(parseOnboardingResumeState('{bad json')).toBeNull();
    expect(parseOnboardingResumeState({ v: 1, screen: 'reasoning', dataSource: 'sample' })).toBeNull();
    expect(parseOnboardingResumeState({ v: ONBOARDING_STATE_VERSION, screen: 'complete', dataSource: 'sample' })).toBeNull();
    expect(parseOnboardingResumeState({ v: ONBOARDING_STATE_VERSION, screen: 'autonomy', dataSource: 'connect' })).toBeNull();
  });

  it('restores focus to the new screen heading', () => {
    const focus = vi.fn();
    const container = { querySelector: () => ({ focus }) };
    expect(focusOnboardingContent(container)).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('stores only safe in-app return hashes and consumes them once', () => {
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, String(value))),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    expect(rememberOnboardingReturnHash('#/settings?tab=ai')).toBe(true);
    expect(values.get(KEY_ONBOARDING_RETURN_HASH)).toBe('#/settings?tab=ai');
    expect(consumeOnboardingReturnHash()).toBe('#/settings?tab=ai');
    expect(consumeOnboardingReturnHash()).toBe('#/connect-gmail');
    expect(rememberOnboardingReturnHash('https://attacker.example')).toBe(false);
  });

  it('applies a provider-mode preference only through the authenticated atomic endpoint', async () => {
    const values = new Map([
      [KEY_ONBOARDING_REASONING_CHOICE, 'bring_your_own_provider'],
      [KEY_SESSION_TOKEN, 'verified-session'],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, String(value))),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ mode: 'bring_your_own_provider', requiresConfirmation: false }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(applyPendingReasoningChoice('user-1')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/user-1/ai/reasoning-mode',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ mode: 'bring_your_own_provider' }),
        headers: expect.objectContaining({ Authorization: 'Bearer verified-session' }),
      }),
    );
    expect(values.has(KEY_ONBOARDING_REASONING_CHOICE)).toBe(false);
  });

  it('keeps an authenticated retry state and does not complete when BYO persistence fails', async () => {
    const values = new Map([
      [KEY_ONBOARDING_REASONING_CHOICE, 'bring_your_own_provider'],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, String(value))),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'temporary failure' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(completePendingGoogleOnboarding({
      sessionToken: 'verified-session',
      userId: 'user-1',
    })).rejects.toThrow();

    expect(values.get(KEY_SESSION_TOKEN)).toBe('verified-session');
    expect(values.get(KEY_USER_ID)).toBe('user-1');
    expect(values.get(KEY_ONBOARDING_REASONING_CHOICE)).toBe('bring_your_own_provider');
    expect(values.has(KEY_ONBOARDED)).toBe(false);
  });

  it('uses route-gated singleton delegation and no inline handlers', () => {
    const source = readFileSync(new URL('./onboarding.js', import.meta.url), 'utf8');
    expect(source).toContain('_listenerWired');
    expect(source).toContain('isOnOnboardingRoute()');
    expect(source).toContain("window.location.hash = '#/briefing'");
    expect(source).not.toContain('createUser(');
    expect(source).not.toMatch(/on(?:click|change|input|keydown)\s*=/i);
    for (const html of [
      renderDataSourceScreen(initialOnboardingState()),
      renderReasoningScreen({ ...initialOnboardingState(), dataSource: 'connect' }),
      renderAutonomyScreen({ ...initialOnboardingState(), dataSource: 'sample' }),
    ]) {
      for (const tag of tags(html)) expect(tag).not.toMatch(/\son(?:click|change|keydown)=/i);
    }
  });

  it('has dialog semantics plus responsive and reduced-motion-safe styling', () => {
    const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
    const storageKeys = readFileSync(new URL('../storage-keys.js', import.meta.url), 'utf8');
    const googleSignin = readFileSync(new URL('../google-signin.js', import.meta.url), 'utf8');
    const index = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../../css/styles.css', import.meta.url), 'utf8');
    expect(index).toContain('role="dialog" aria-modal="true" aria-labelledby="onboarding-title"');
    expect(styles).toContain('@media (max-width: 600px)');
    expect(styles).toContain('.onboarding-actions { align-items: stretch; flex-direction: column-reverse; }');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(app).toContain("event.key !== 'Tab'");
    expect(app).toContain("setAttribute('inert', '')");
    expect(app).toContain('_onboardingPreviousFocus');
    expect(app).toContain('rememberOnboardingReturnHash(`#${hashRaw}`)');
    expect(app).toContain('const existingSession = localStorage.getItem(KEY_SESSION_TOKEN)');
    expect(app).not.toContain('KEY_GOOGLE_SIGNIN_PENDING');
    expect(app).not.toContain('googlePendingKey');
    expect(storageKeys).not.toContain('skytwin_google_signin_pending');
    expect(googleSignin).not.toMatch(/(?:localStorage|sessionStorage)\.(?:setItem|getItem).*pending/i);
  });
});
