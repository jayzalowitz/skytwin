import { describe, it, expect } from 'vitest';
import {
  assertDemoSafe,
  assertDemoUser,
  isLocalDbTarget,
  REQUIRED_OVERRIDE_TOKEN,
} from '../seeds/demo-guard.js';

const local = { nodeEnv: 'development', dbTarget: 'postgresql://localhost:26257/skytwin', explicitOptIn: true };

describe('assertDemoSafe — three-gate guard (spec 09 invariant #0)', () => {
  it('passes for an explicitly-requested local dev run', () => {
    expect(assertDemoSafe(local).ok).toBe(true);
  });

  it('GATE 1: refuses when not explicitly requested (never implicit / never for new users)', () => {
    const r = assertDemoSafe({ ...local, explicitOptIn: false });
    expect(r.ok).toBe(false);
  });

  it('GATE 2: hard-blocks production even WITH the override token', () => {
    const r = assertDemoSafe({
      nodeEnv: 'production',
      dbTarget: 'postgresql://localhost/skytwin',
      explicitOptIn: true,
      overrideToken: REQUIRED_OVERRIDE_TOKEN,
    });
    expect(r.ok).toBe(false);
  });

  it('GATE 2: refuses a non-local DB without the override token', () => {
    const r = assertDemoSafe({
      nodeEnv: 'development',
      dbTarget: 'postgresql://prod-db.example.com:26257/skytwin',
      explicitOptIn: true,
    });
    expect(r.ok).toBe(false);
  });

  it('GATE 2: allows a non-local DB only WITH the correct override token (non-prod)', () => {
    const r = assertDemoSafe({
      nodeEnv: 'development',
      dbTarget: 'postgresql://staging-db.example.com/skytwin',
      explicitOptIn: true,
      overrideToken: REQUIRED_OVERRIDE_TOKEN,
    });
    expect(r.ok).toBe(true);
  });
});

describe('isLocalDbTarget', () => {
  it('treats localhost / 127.0.0.1 / ::1 / unset as local', () => {
    expect(isLocalDbTarget('postgresql://localhost:26257')).toBe(true);
    expect(isLocalDbTarget('127.0.0.1')).toBe(true);
    expect(isLocalDbTarget(undefined)).toBe(true);
    expect(isLocalDbTarget('')).toBe(true);
  });
  it('treats remote hosts as non-local', () => {
    expect(isLocalDbTarget('postgresql://db.example.com/skytwin')).toBe(false);
    expect(isLocalDbTarget('10.0.0.5')).toBe(false);
  });

  it('is not fooled by hosts that merely CONTAIN localhost/127.0.0.1 (review #8)', () => {
    expect(isLocalDbTarget('postgresql://user:pass@localhost-fake.evil.com/db')).toBe(false);
    expect(isLocalDbTarget('postgresql://evil.com/db?host=localhost')).toBe(false);
    expect(isLocalDbTarget('postgresql://127.0.0.1.evil.com/db')).toBe(false);
  });
});

describe('assertDemoUser — identity isolation (GATE 3)', () => {
  it('throws when asked to write to a non-demo (real) user', () => {
    expect(() => assertDemoUser('real-user', false)).toThrow(/non-demo user/);
  });
  it('allows writes to a demo-flagged user', () => {
    expect(() => assertDemoUser('demo-user', true)).not.toThrow();
  });
});
