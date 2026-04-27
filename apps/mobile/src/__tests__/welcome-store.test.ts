import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => store.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    store.set(k, v);
  },
  deleteItemAsync: async (k: string) => {
    store.delete(k);
  },
}));

import { hasSeenWelcome, markWelcomeSeen, resetWelcome } from '../services/welcome-store.js';

describe('welcome-store', () => {
  beforeEach(() => {
    store.clear();
  });

  it('hasSeenWelcome returns false on first launch (key missing)', async () => {
    expect(await hasSeenWelcome()).toBe(false);
  });

  it('returns true after markWelcomeSeen', async () => {
    await markWelcomeSeen();
    expect(await hasSeenWelcome()).toBe(true);
  });

  it('resetWelcome clears the flag (debug helper)', async () => {
    await markWelcomeSeen();
    await resetWelcome();
    expect(await hasSeenWelcome()).toBe(false);
  });

  it('treats unrelated stored values as not-seen (only "1" counts)', async () => {
    store.set('skytwin_welcome_seen', '0');
    expect(await hasSeenWelcome()).toBe(false);
    store.set('skytwin_welcome_seen', 'true');
    expect(await hasSeenWelcome()).toBe(false);
  });
});
