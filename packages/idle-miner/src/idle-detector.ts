export interface IdleDetectorPort {
  start(): void;
  stop(): void;
  onIdle(handler: () => void): void;
  onActive(handler: () => void): void;
}

/**
 * Electron-based idle detector using powerMonitor.
 * Loaded via dynamic import so the package works in pure-Node contexts.
 */
export class ElectronIdleDetector implements IdleDetectorPort {
  private idleHandlers: Array<() => void> = [];
  private activeHandlers: Array<() => void> = [];
  private started = false;
  private readonly idleThresholdSeconds: number;

  // Bound listener references for removal
  private boundIdle: (() => void) | null = null;
  private boundActive: (() => void) | null = null;

  constructor(idleThresholdSeconds = 60) {
    this.idleThresholdSeconds = idleThresholdSeconds;
  }

  onIdle(handler: () => void): void {
    this.idleHandlers.push(handler);
  }

  onActive(handler: () => void): void {
    this.activeHandlers.push(handler);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.attachElectronListeners();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.detachElectronListeners();
  }

  private attachElectronListeners(): void {
    // Dynamic import avoids a hard dependency on Electron at module load time.
    // The specifier is held in a variable to prevent tsc from attempting static
    // type-resolution of 'electron' (which is unavailable in non-Electron builds).
    const electronSpecifier = 'electron';
    void (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const electronMod = await import(electronSpecifier) as Record<string, unknown>;
        const powerMonitor = (electronMod['powerMonitor'] ?? (electronMod['default'] as Record<string, unknown> | undefined)?.['powerMonitor']) as {
          getSystemIdleTime(): number;
          on(event: string, listener: () => void): void;
          off(event: string, listener: () => void): void;
        } | undefined;
        if (!powerMonitor) return;

        const idleCheckMs = this.idleThresholdSeconds * 1000;
        let idleTimer: ReturnType<typeof setInterval> | null = null;
        let currentlyIdle = false;

        const checkIdle = () => {
          const idleTime = powerMonitor.getSystemIdleTime() * 1000;
          if (idleTime >= idleCheckMs && !currentlyIdle) {
            currentlyIdle = true;
            for (const h of this.idleHandlers) h();
          } else if (idleTime < idleCheckMs && currentlyIdle) {
            currentlyIdle = false;
            for (const h of this.activeHandlers) h();
          }
        };

        this.boundIdle = () => {
          if (idleTimer !== null) {
            clearInterval(idleTimer);
            idleTimer = null;
          }
          idleTimer = setInterval(checkIdle, 5_000);
        };
        this.boundActive = () => {
          if (idleTimer !== null) {
            clearInterval(idleTimer);
            idleTimer = null;
          }
          currentlyIdle = false;
          for (const h of this.activeHandlers) h();
        };

        powerMonitor.on('lock-screen', this.boundIdle);
        powerMonitor.on('unlock-screen', this.boundActive);
      } catch {
        // Not running in Electron — silently no-op
      }
    })();
  }

  private detachElectronListeners(): void {
    const electronSpecifier = 'electron';
    void (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const electronMod = await import(electronSpecifier) as Record<string, unknown>;
        const powerMonitor = (electronMod['powerMonitor'] ?? (electronMod['default'] as Record<string, unknown> | undefined)?.['powerMonitor']) as {
          off(event: string, listener: () => void): void;
        } | undefined;
        if (!powerMonitor) return;
        if (this.boundIdle) powerMonitor.off('lock-screen', this.boundIdle);
        if (this.boundActive) powerMonitor.off('unlock-screen', this.boundActive);
      } catch {
        // Not running in Electron
      }
    })();
  }
}

/**
 * Mock idle detector for tests — allows manually triggering idle/active.
 */
export class MockIdleDetector implements IdleDetectorPort {
  private idleHandlers: Array<() => void> = [];
  private activeHandlers: Array<() => void> = [];

  onIdle(handler: () => void): void {
    this.idleHandlers.push(handler);
  }

  onActive(handler: () => void): void {
    this.activeHandlers.push(handler);
  }

  start(): void {
    // no-op for mock
  }

  stop(): void {
    // no-op for mock
  }

  triggerIdle(): void {
    for (const h of this.idleHandlers) h();
  }

  triggerActive(): void {
    for (const h of this.activeHandlers) h();
  }
}
