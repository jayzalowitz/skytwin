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
    const openExternal = vi.fn();
    installVaultNavigationGuards(target, openExternal);
    const preventDefault = vi.fn();
    listeners.get(eventName)!({ preventDefault }, 'https://example.com/');
    expect(preventDefault).toHaveBeenCalledOnce();
    preventDefault.mockClear();
    listeners.get(eventName)!({ preventDefault }, 'http://localhost:3200/dashboard');
    expect(preventDefault).not.toHaveBeenCalled();
    expect(target.setWindowOpenHandler.mock.calls[0]![0]({ url: 'mailto:test@example.com' }))
      .toEqual({ action: 'deny' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['http://example.com/setup?source=desktop', 'http://example.com/setup?source=desktop'],
    ['https://accounts.google.com/o/oauth2/auth#consent', 'https://accounts.google.com/o/oauth2/auth#consent'],
  ])('opens web-only new-window destination %s in the system browser', (url, expected) => {
    const target = { on: vi.fn(), setWindowOpenHandler: vi.fn() };
    const openExternal = vi.fn();
    installVaultNavigationGuards(target, openExternal);

    const handler = target.setWindowOpenHandler.mock.calls[0]![0];
    expect(handler({ url })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith(expected);
  });

  it.each(['mailto:test@example.com', 'javascript:alert(1)', 'not a url'])(
    'denies non-web or malformed new-window destination %s',
    url => {
      const target = { on: vi.fn(), setWindowOpenHandler: vi.fn() };
      const openExternal = vi.fn();
      installVaultNavigationGuards(target, openExternal);

      const handler = target.setWindowOpenHandler.mock.calls[0]![0];
      expect(handler({ url })).toEqual({ action: 'deny' });
      expect(openExternal).not.toHaveBeenCalled();
    },
  );

  it('contains rejected system-browser opens while denying the Electron window', async () => {
    const target = { on: vi.fn(), setWindowOpenHandler: vi.fn() };
    const openExternal = vi.fn().mockRejectedValue(new Error('system browser unavailable'));
    installVaultNavigationGuards(target, openExternal);

    const handler = target.setWindowOpenHandler.mock.calls[0]![0];
    expect(handler({ url: 'https://example.com/setup' })).toEqual({ action: 'deny' });
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledOnce();
  });

  it('does not expose source-key custody through preload or renderer IPC', () => {
    const preload = readFileSync(new URL('../preload.ts', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
    expect(preload).not.toContain('sourceVault');
    expect(main).not.toContain("ipcMain.handle('source-vault-");
  });
});
