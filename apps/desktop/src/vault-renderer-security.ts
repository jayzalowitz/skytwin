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
