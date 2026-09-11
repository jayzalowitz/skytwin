const DASHBOARD_ORIGINS = new Set(['http://localhost:3200', 'http://127.0.0.1:3200']);

/** Exact origins allowed to retain the privileged desktop preload bridge. */
export function isTrustedDashboardUrl(value: string): boolean {
  try {
    return DASHBOARD_ORIGINS.has(new URL(value).origin);
  } catch {
    return false;
  }
}

export interface PreventableNavigationEvent { preventDefault(): void }
export interface NavigationGuardTarget {
  on(event: 'will-navigate' | 'will-redirect', listener: (event: PreventableNavigationEvent, target: string) => void): unknown;
  setWindowOpenHandler(handler: () => { action: 'deny' }): unknown;
}

/** Apply the same exact-origin policy to direct navigations and redirects. */
export function installVaultNavigationGuards(target: NavigationGuardTarget): void {
  const guard = (event: PreventableNavigationEvent, destination: string) => {
    if (!isTrustedDashboardUrl(destination)) event.preventDefault();
  };
  target.on('will-navigate', guard);
  target.on('will-redirect', guard);
  target.setWindowOpenHandler(() => ({ action: 'deny' }));
}

type VerifyOwner = (userId: string, sessionToken: string) => Promise<boolean>;

/** Binds one renderer process to one authenticated owner and throttles KDF work. */
export class VaultRendererAuthorizer {
  private readonly users = new Map<number, string>();
  private readonly lastKdfAt = new Map<number, number>();

  constructor(private readonly verifyOwner: VerifyOwner, private readonly now: () => number = Date.now) {}

  async authorize(senderId: number, frameUrl: string | undefined, userId: unknown, sessionToken: unknown, expensive = false): Promise<boolean> {
    if (!frameUrl || !isTrustedDashboardUrl(frameUrl) || typeof userId !== 'string' || typeof sessionToken !== 'string' || sessionToken.length < 32 || sessionToken.length > 512) return false;
    const bound = this.users.get(senderId);
    if (bound && bound !== userId) return false;
    const reserved = bound === undefined;
    if (reserved) this.users.set(senderId, userId);
    if (expensive) {
      const now = this.now(), last = this.lastKdfAt.get(senderId) ?? 0;
      if (now - last < 1_000) { if (reserved) this.users.delete(senderId); return false; }
      this.lastKdfAt.set(senderId, now);
    }
    let verified = false;
    try { verified = await this.verifyOwner(userId, sessionToken); } catch { verified = false; }
    // `release()` may have run while verification was in flight. Do not
    // resurrect authorization for a destroyed renderer or reused sender id.
    if (!verified || this.users.get(senderId) !== userId) {
      if (reserved && this.users.get(senderId) === userId) this.users.delete(senderId);
      return false;
    }
    return true;
  }

  release(senderId: number): void {
    this.users.delete(senderId);
    this.lastKdfAt.delete(senderId);
  }
}
