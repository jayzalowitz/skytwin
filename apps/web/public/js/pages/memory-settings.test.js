// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./memory-settings.js', import.meta.url), 'utf8');

describe('memory settings page storage keys', () => {
  it('uses the centralized dashboard localStorage keys', () => {
    expect(source).toContain("import { KEY_SESSION_TOKEN, KEY_USER_ID } from '../storage-keys.js'");
    expect(source).toContain('localStorage.getItem(KEY_USER_ID)');
    expect(source).toContain('localStorage.getItem(KEY_SESSION_TOKEN)');
  });

  it('does not use obsolete dotted storage keys', () => {
    expect(source).not.toContain('skytwin.userId');
    expect(source).not.toContain('skytwin.sessionToken');
  });
});
