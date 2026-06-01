import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
  getItemAsync: vi.fn(async (k: string) => store.get(k) ?? null),
  deleteItemAsync: vi.fn(async (k: string) => { store.delete(k); }),
}));

import {
  rememberManualHost,
  getRememberedManualHost,
  clearRememberedManualHost,
} from '../services/paired-host-store';

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('paired-host-store', () => {
  it('returns null when nothing is remembered', async () => {
    expect(await getRememberedManualHost()).toBeNull();
  });

  it('persists and retrieves a manual host', async () => {
    await rememberManualHost('192.168.1.42:3100');
    expect(await getRememberedManualHost()).toBe('192.168.1.42:3100');
  });

  it('trims surrounding whitespace before persisting', async () => {
    await rememberManualHost('  10.0.0.5  ');
    expect(await getRememberedManualHost()).toBe('10.0.0.5');
  });

  it('ignores an empty / whitespace-only value', async () => {
    await rememberManualHost('   ');
    expect(await getRememberedManualHost()).toBeNull();
  });

  it('overwrites a prior host on a new successful pair', async () => {
    await rememberManualHost('192.168.1.42');
    await rememberManualHost('192.168.1.99');
    expect(await getRememberedManualHost()).toBe('192.168.1.99');
  });

  it('clears the remembered host', async () => {
    await rememberManualHost('192.168.1.42');
    await clearRememberedManualHost();
    expect(await getRememberedManualHost()).toBeNull();
  });
});
