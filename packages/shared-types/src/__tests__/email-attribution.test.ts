import { describe, expect, it } from 'vitest';
import {
  SKYTWIN_EMAIL_ATTRIBUTION_SIGNATURE,
  SKYTWIN_REPO_URL,
  appendSkyTwinEmailAttribution,
  hasSkyTwinEmailAttribution,
  resolveEmailAttributionEnabled,
} from '../email-attribution.js';

describe('resolveEmailAttributionEnabled', () => {
  it('defaults on unless the user explicitly disables it', () => {
    expect(resolveEmailAttributionEnabled(undefined)).toBe(true);
    expect(resolveEmailAttributionEnabled({})).toBe(true);
    expect(resolveEmailAttributionEnabled({ emailAttributionSignatureEnabled: true })).toBe(true);
    expect(resolveEmailAttributionEnabled({ emailAttributionSignatureEnabled: false })).toBe(false);
  });
});

describe('appendSkyTwinEmailAttribution', () => {
  it('appends the SkyTwin signature with the repo URL', () => {
    const out = appendSkyTwinEmailAttribution('Thanks,\nJay');

    expect(out).toBe(`Thanks,\nJay\n\n${SKYTWIN_EMAIL_ATTRIBUTION_SIGNATURE}`);
    expect(out).toContain(SKYTWIN_REPO_URL);
  });

  it('does not append when disabled', () => {
    expect(appendSkyTwinEmailAttribution('Thanks', { enabled: false })).toBe('Thanks');
  });

  it('does not duplicate an existing attribution', () => {
    const body = `Thanks\n\n${SKYTWIN_EMAIL_ATTRIBUTION_SIGNATURE}`;

    expect(appendSkyTwinEmailAttribution(body)).toBe(body);
    expect(hasSkyTwinEmailAttribution(body)).toBe(true);
  });

  it('handles empty bodies without leading blank lines', () => {
    expect(appendSkyTwinEmailAttribution('')).toBe(SKYTWIN_EMAIL_ATTRIBUTION_SIGNATURE);
  });
});
