import { describe, it, expect } from 'vitest';
import { assertSessionSecret } from '../startup-assertions.js';

describe('assertSessionSecret', () => {
  it('passes silently in development even with unset secret', () => {
    const result = assertSessionSecret({ nodeEnv: 'development' });
    expect(result.ok).toBe(true);
    expect(result.fatal).toBe(false);
  });

  it('passes silently in test even with the dev default', () => {
    const result = assertSessionSecret({
      nodeEnv: 'test',
      sessionSecret: 'skytwin-dev-secret',
    });
    expect(result.ok).toBe(true);
  });

  it('refuses to start in production with no SESSION_SECRET set', () => {
    const result = assertSessionSecret({ nodeEnv: 'production' });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.message).toContain('SESSION_SECRET must be set');
  });

  it('refuses to start in production with the hardcoded dev default', () => {
    const result = assertSessionSecret({
      nodeEnv: 'production',
      sessionSecret: 'skytwin-dev-secret',
    });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.message).toMatch(/hardcoded dev default/);
  });

  it('refuses to start in production with a too-short secret', () => {
    const result = assertSessionSecret({
      nodeEnv: 'production',
      sessionSecret: 'short',
    });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.message).toMatch(/too short/);
  });

  it('passes in production with a real secret of sufficient length', () => {
    const result = assertSessionSecret({
      nodeEnv: 'production',
      sessionSecret: 'a'.repeat(64),
    });
    expect(result.ok).toBe(true);
    expect(result.fatal).toBe(false);
  });

  it('honours custom defaultDevSecret/minLength overrides', () => {
    const result = assertSessionSecret({
      nodeEnv: 'staging',
      sessionSecret: 'mydefault',
      defaultDevSecret: 'mydefault',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/hardcoded dev default/);
  });

  it('treats staging the same as production (anything non-dev/test)', () => {
    const result = assertSessionSecret({ nodeEnv: 'staging' });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
  });
});
