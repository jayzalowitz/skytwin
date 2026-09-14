// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./settings.js', import.meta.url), 'utf8');

describe('web sign-out assistant cleanup', () => {
  it('removes the departing owner pending request before identity storage', () => {
    const clearIndex = source.indexOf('clearPendingAssistantRequest(departingUserId)');
    const identityIndex = source.indexOf('localStorage.removeItem(KEY_USER_ID)');
    expect(clearIndex).toBeGreaterThan(0);
    expect(clearIndex).toBeLessThan(identityIndex);
  });
});
