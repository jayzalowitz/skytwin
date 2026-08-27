import { describe, it, expect } from 'vitest';
import { parseRunnerConfig } from '../config.js';

const base = (): Record<string, string | undefined> => ({
  SKYTWIN_IDLE_MINER_ENABLED: 'true',
  SKYTWIN_IDLE_MINER_USER_ID: 'user-1',
  SKYTWIN_IDLE_MINER_INGEST_URL: 'http://localhost:3200/api/events/ingest',
  SKYTWIN_IDLE_MINER_DATA_DIR: '/var/lib/skytwin/idle',
  HOME: '/home/u',
});

describe('parseRunnerConfig — fail-closed', () => {
  it('accepts a complete, valid env', () => {
    const r = parseRunnerConfig(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config).toEqual({
        userId: 'user-1',
        ingestUrl: 'http://localhost:3200/api/events/ingest',
        dataDir: '/var/lib/skytwin/idle',
        homedir: '/home/u',
      });
    }
  });

  it('is disabled by default (flag unset)', () => {
    const env = base();
    delete env.SKYTWIN_IDLE_MINER_ENABLED;
    const r = parseRunnerConfig(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/disabled|ENABLED/);
  });

  it.each(['false', 'TRUE', '1', 'yes', ''])('is disabled when the flag is %j (only "true" enables)', (v) => {
    expect(parseRunnerConfig({ ...base(), SKYTWIN_IDLE_MINER_ENABLED: v }).ok).toBe(false);
  });

  it('refuses without a resolved userId (fail-closed: no user, no mining)', () => {
    const env = base();
    delete env.SKYTWIN_IDLE_MINER_USER_ID;
    const r = parseRunnerConfig(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/USER_ID/);
  });

  it('refuses without an ingest URL', () => {
    const env = base();
    delete env.SKYTWIN_IDLE_MINER_INGEST_URL;
    expect(parseRunnerConfig(env).ok).toBe(false);
  });

  it('refuses a malformed ingest URL', () => {
    const r = parseRunnerConfig({ ...base(), SKYTWIN_IDLE_MINER_INGEST_URL: 'not a url' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/valid URL/);
  });

  it('refuses without a data dir', () => {
    const env = base();
    delete env.SKYTWIN_IDLE_MINER_DATA_DIR;
    expect(parseRunnerConfig(env).ok).toBe(false);
  });

  it('refuses when no home dir can be resolved (no HOME/USERPROFILE)', () => {
    const env = base();
    delete env.HOME;
    const r = parseRunnerConfig(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/home directory/);
  });

  it('falls back to USERPROFILE for the home dir (Windows)', () => {
    const env = base();
    delete env.HOME;
    env.USERPROFILE = 'C:\\Users\\u';
    const r = parseRunnerConfig(env);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.homedir).toBe('C:\\Users\\u');
  });

  it('prefers SKYTWIN_IDLE_MINER_HOME over HOME', () => {
    const r = parseRunnerConfig({ ...base(), SKYTWIN_IDLE_MINER_HOME: '/custom/home' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.homedir).toBe('/custom/home');
  });

  it('ignores whitespace-only values (treats them as absent)', () => {
    expect(parseRunnerConfig({ ...base(), SKYTWIN_IDLE_MINER_USER_ID: '   ' }).ok).toBe(false);
  });

  // The loopback service credential the desktop mints. Without it, mined
  // signals 401 against a packaged build's API (bypass off).
  it('carries SKYTWIN_SERVICE_TOKEN through to the config', () => {
    const r = parseRunnerConfig({ ...base(), SKYTWIN_SERVICE_TOKEN: 'tok-abc' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.serviceToken).toBe('tok-abc');
  });

  it('still starts without a service token (dev API with the localhost bypass on)', () => {
    const r = parseRunnerConfig(base());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.serviceToken).toBeUndefined();
  });

  it('treats a whitespace-only service token as absent', () => {
    const r = parseRunnerConfig({ ...base(), SKYTWIN_SERVICE_TOKEN: '   ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.serviceToken).toBeUndefined();
  });
});
