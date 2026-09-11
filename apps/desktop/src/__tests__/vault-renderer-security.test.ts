import { describe, expect, it, vi } from 'vitest';
import { installVaultNavigationGuards, isTrustedDashboardUrl, VaultRendererAuthorizer } from '../vault-renderer-security.js';

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

  it('requires owner verification, rejects foreign frames, and binds a sender to one user', async () => {
    const verify = vi.fn(async (_userId: string, token: string) => token === 'x'.repeat(32));
    const authorizer = new VaultRendererAuthorizer(verify);
    expect(await authorizer.authorize(7, 'https://example.com/', 'user-0001', 'x'.repeat(32))).toBe(false);
    expect(await authorizer.authorize(7, 'http://localhost:3200/', 'user-0001', 'bad'.repeat(11))).toBe(false);
    expect(await authorizer.authorize(7, 'http://localhost:3200/', 'user-0001', 'x'.repeat(32))).toBe(true);
    expect(await authorizer.authorize(7, 'http://localhost:3200/', 'user-0002', 'x'.repeat(32))).toBe(false);
    expect(verify).toHaveBeenCalledTimes(2);
    authorizer.release(7);
    expect(await authorizer.authorize(7, 'http://localhost:3200/', 'user-0002', 'x'.repeat(32))).toBe(true);
  });

  it('rate-limits expensive calls per renderer', async () => {
    let now = 10_000;
    const authorizer = new VaultRendererAuthorizer(async () => true, () => now);
    expect(await authorizer.authorize(9, 'http://127.0.0.1:3200/', 'user-0001', 'x'.repeat(32), true)).toBe(true);
    expect(await authorizer.authorize(9, 'http://127.0.0.1:3200/', 'user-0001', 'x'.repeat(32), true)).toBe(false);
    now += 1_000;
    expect(await authorizer.authorize(9, 'http://127.0.0.1:3200/', 'user-0001', 'x'.repeat(32), true)).toBe(true);
  });

  it('reserves owner identity across async verification and does not resurrect released renderers', async () => {
    let finish!: (value: boolean) => void;
    const authorizer = new VaultRendererAuthorizer(() => new Promise(resolve => { finish = resolve; }));
    const first = authorizer.authorize(11, 'http://localhost:3200/', 'user-0001', 'x'.repeat(32));
    expect(await authorizer.authorize(11, 'http://localhost:3200/', 'user-0002', 'x'.repeat(32))).toBe(false);
    authorizer.release(11);
    finish(true);
    expect(await first).toBe(false);
  });
});
