import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { installVaultNavigationGuards, isTrustedDashboardUrl } from '../vault-renderer-security.js';

describe('vault renderer navigation security', () => {
  it('accepts only the two exact loopback dashboard origins', () => {
    expect(isTrustedDashboardUrl('http://localhost:3200/settings?tab=vault')).toBe(true);
    expect(isTrustedDashboardUrl('http://127.0.0.1:3200/')).toBe(true);
    expect(isTrustedDashboardUrl('https://localhost:3200/')).toBe(false);
    expect(isTrustedDashboardUrl('http://localhost:3201/')).toBe(false);
    expect(isTrustedDashboardUrl('http://localhost.evil.example:3200/')).toBe(false);
    expect(isTrustedDashboardUrl('not a url')).toBe(false);
  });

  it.each(['will-navigate', 'will-redirect'] as const)('blocks foreign %s destinations', eventName => {
    const listeners = new Map<string, (event: { preventDefault(): void }, url: string) => void>();
    const target = {
      on: vi.fn((name: string, listener: (event: { preventDefault(): void }, url: string) => void) => { listeners.set(name, listener); }),
      setWindowOpenHandler: vi.fn(),
    };
    installVaultNavigationGuards(target);
    const preventDefault = vi.fn();
    listeners.get(eventName)!({ preventDefault }, 'https://example.com/');
    expect(preventDefault).toHaveBeenCalledOnce();
    preventDefault.mockClear();
    listeners.get(eventName)!({ preventDefault }, 'http://localhost:3200/dashboard');
    expect(preventDefault).not.toHaveBeenCalled();
    expect(target.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' });
  });

  it('does not expose source-key custody through preload or renderer IPC', () => {
    const preload = readFileSync(new URL('../preload.ts', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
    expect(preload).not.toContain('sourceVault');
    expect(main).not.toContain("ipcMain.handle('source-vault-");
  });
});
