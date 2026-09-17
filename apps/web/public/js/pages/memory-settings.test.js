// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./memory-settings.js', import.meta.url), 'utf8');

describe('memory settings page storage keys', () => {
  it('uses the effective auth abstraction for real and sample sessions', () => {
    expect(source).toContain("from '../sample-session.js'");
    expect(source).toContain('getEffectiveUserId()');
    expect(source).toContain('getEffectiveAuthToken()');
  });

  it('does not use obsolete dotted storage keys', () => {
    expect(source).not.toContain('skytwin.userId');
    expect(source).not.toContain('skytwin.sessionToken');
  });

  it('does not claim hybrid mode imports a separately installed gbrain', () => {
    expect(source).toContain('SkyTwin does not read or import that brain automatically');
    expect(source).toContain('it does not connect the external installation');
    expect(source).not.toContain('combine your existing brain with mempalace');
  });
});
