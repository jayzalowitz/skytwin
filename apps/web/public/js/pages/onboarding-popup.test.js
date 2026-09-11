// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signInMocks = vi.hoisted(() => ({
  startGoogleSignIn: vi.fn(),
}));

vi.mock('../google-signin.js', () => signInMocks);

import { renderOnboarding } from './onboarding.js';

describe('onboarding browser activation boundary', () => {
  beforeEach(() => {
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, String(value))),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    window.location.hash = '#/';
    document.body.innerHTML = `
      <div id="onboarding-overlay" style="display:block">
        <div id="onboarding-content"></div>
      </div>`;
    signInMocks.startGoogleSignIn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('enters the preloaded sign-in helper synchronously from the delegated finish click', async () => {
    const order = [];
    const openWindow = vi.spyOn(window, 'open').mockImplementation(() => {
      order.push('popup-reserved');
      return {};
    });
    signInMocks.startGoogleSignIn.mockImplementation(() => {
      window.open('', 'skytwin-google-signin');
      return new Promise(() => {});
    });

    await renderOnboarding(null, vi.fn());

    document.querySelector('input[name="data-source"][value="connect"]').click();
    document.querySelector('[data-action="onb-next"]').click();
    document.querySelector('input[name="reasoning-mode"][value="not_configured"]').click();
    document.querySelector('[data-action="onb-next"]').click();
    document.querySelector('[data-action="onb-next"]').click();

    document.querySelector('[data-action="onb-finish"]').click();
    order.push('click-returned');

    expect(signInMocks.startGoogleSignIn).toHaveBeenCalledOnce();
    expect(openWindow).toHaveBeenCalledOnce();
    expect(order).toEqual(['popup-reserved', 'click-returned']);
  });
});
