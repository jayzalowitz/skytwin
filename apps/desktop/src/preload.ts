import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload script: exposes a minimal API from the Electron main process
 * to the web renderer via contextBridge.
 */
contextBridge.exposeInMainWorld('skytwinDesktop', {
  /** Check if running inside the desktop app */
  isDesktop: true,

  /** Get service status (API + Worker + overall) */
  getServiceStatus: () => ipcRenderer.invoke('get-service-status'),

  /** Get the app version */
  getVersion: () => ipcRenderer.invoke('get-version'),

  /** Platform info */
  platform: process.platform,

  /** Auto-launch at login */
  getLaunchAtLogin: () => ipcRenderer.invoke('get-launch-at-login'),
  setLaunchAtLogin: (enabled: boolean) => ipcRenderer.invoke('set-launch-at-login', enabled),

  /** Pause/resume the twin (worker) */
  pauseTwin: () => ipcRenderer.invoke('pause-twin'),
  resumeTwin: () => ipcRenderer.invoke('resume-twin'),

  /**
   * "Pause background work when idle" preference (#382).
   * Default ON. Setter returns the persisted value, so callers can
   * round-trip-confirm and resync UI if the underlying store had a
   * different value (e.g. another window already toggled it).
   */
  getIdlePauseEnabled: () =>
    ipcRenderer.invoke('get-idle-pause-enabled') as Promise<boolean>,
  setIdlePauseEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('set-idle-pause-enabled', enabled) as Promise<boolean>,

  /**
   * "Send anonymous crash reports" preference (#399). Default OFF —
   * opt-in only. Setter returns the persisted value so the renderer can
   * round-trip-confirm, matching the idle-pause toggle's contract.
   */
  getCrashReportsEnabled: () =>
    ipcRenderer.invoke('get-crash-reports-enabled') as Promise<boolean>,
  setCrashReportsEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('set-crash-reports-enabled', enabled) as Promise<boolean>,

  /** Open a URL in the system default browser (used for OAuth) */
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

  /**
   * Credential-vault passphrase "remember on this device" (#401).
   *
   * The passphrase is encrypted by the OS keychain (Electron safeStorage) in
   * the main process before it ever touches disk — plaintext crosses this
   * bridge only on the way in (remember) and out (get), never to storage.
   *
   * `vaultPassphraseSupported()` is false on environments without an OS secret
   * store (e.g. headless Linux with no Secret Service); the renderer hides the
   * "Remember on this device?" prompt and keeps the per-session behavior.
   */
  vaultPassphraseSupported: () =>
    ipcRenderer.invoke('vault-passphrase-supported') as Promise<boolean>,
  vaultPassphraseRemember: (userId: string, passphrase: string) =>
    ipcRenderer.invoke('vault-passphrase-remember', userId, passphrase) as Promise<
      { ok: true } | { ok: false; reason: 'unsupported' | 'empty_passphrase' }
    >,
  vaultPassphraseGet: (userId: string) =>
    ipcRenderer.invoke('vault-passphrase-get', userId) as Promise<
      | { ok: true; passphrase: string }
      | { ok: false; reason: 'unsupported' | 'not_found' | 'corrupt' }
    >,
  vaultPassphraseHas: (userId: string) =>
    ipcRenderer.invoke('vault-passphrase-has', userId) as Promise<boolean>,
  vaultPassphraseForget: (userId: string) =>
    ipcRenderer.invoke('vault-passphrase-forget', userId) as Promise<void>,

  /**
   * Subscribe to idle state changes from the OS-level powerMonitor.
   * Returns an unsubscribe function. The renderer can use this to fire
   * proactive scans when the user goes idle, or to pause expensive work
   * when the screen is locked.
   */
  onIdleStateChanged: (
    listener: (payload: {
      state: 'idle' | 'active';
      reason: string;
    }) => void,
  ): (() => void) => {
    const wrapped = (
      _e: Electron.IpcRendererEvent,
      payload: { state: 'idle' | 'active'; reason: string },
    ) => listener(payload);
    ipcRenderer.on('idle-state-changed', wrapped);
    return () => ipcRenderer.off('idle-state-changed', wrapped);
  },

  /**
   * Read a DXT file from disk by path. Used by the renderer when the OS
   * passed us a path via the `open-file` event (double-click on a .dxt file)
   * or via drag-drop where the renderer extracted only the path. Returns
   * `{ name, base64 }`.
   */
  readDxtFile: (filePath: string) =>
    ipcRenderer.invoke('read-dxt-file', filePath) as Promise<{ name: string; base64: string }>,

  /**
   * Subscribe to OS-level "open this DXT file" events. Returns an
   * unsubscribe function. Fires when the user double-clicks a .dxt file
   * in Finder/Explorer (file association required) or otherwise hands one
   * to the OS to open with SkyTwin.
   */
  onDxtFileOpened: (
    listener: (payload: { path: string }) => void,
  ): (() => void) => {
    const wrapped = (
      _e: Electron.IpcRendererEvent,
      payload: { path: string },
    ) => listener(payload);
    ipcRenderer.on('dxt-file-opened', wrapped);
    return () => ipcRenderer.off('dxt-file-opened', wrapped);
  },

  /**
   * Subscribe to the "first window close in this session" event (#381).
   * The main process fires this exactly once per launch, the first
   * time the user closes the window — the renderer responds by
   * showing a toast explaining that the app keeps running in the
   * tray. Returns an unsubscribe function for symmetry; in practice
   * the listener lives for the lifetime of the app.
   */
  onFirstCloseToast: (listener: () => void): (() => void) => {
    const wrapped = () => listener();
    ipcRenderer.on('show-first-close-toast', wrapped);
    return () => ipcRenderer.off('show-first-close-toast', wrapped);
  },

  /**
   * Auto-update surface (#370 follow-up). The renderer shows a banner that
   * reflects the update lifecycle and lets the user install on demand.
   *
   * - `checkForUpdates()` triggers an immediate poll (the same as the
   *   "Check for Updates…" menu item).
   * - `getUpdateStatus()` reads the latest known status (for a fresh page load
   *   that missed earlier push events).
   * - `installUpdate()` quits + relaunches into a downloaded update. Resolves
   *   `false` when nothing is installable (dev/unsigned build, or no payload
   *   downloaded yet).
   * - `onUpdateStatus(listener)` subscribes to the live status stream
   *   (available → downloading(%) → ready-to-install / error). Returns an
   *   unsubscribe function.
   */
  checkForUpdates: () =>
    ipcRenderer.invoke('update-check') as Promise<{
      status: string;
      version?: string;
      downloadPercent?: number;
      error?: string;
    }>,
  getUpdateStatus: () =>
    ipcRenderer.invoke('get-update-status') as Promise<{
      status: string;
      version?: string;
      downloadPercent?: number;
      error?: string;
    }>,
  installUpdate: () => ipcRenderer.invoke('update-install') as Promise<boolean>,
  onUpdateStatus: (
    listener: (payload: {
      status: string;
      version?: string;
      downloadPercent?: number;
      error?: string;
    }) => void,
  ): (() => void) => {
    const wrapped = (
      _e: Electron.IpcRendererEvent,
      payload: { status: string; version?: string; downloadPercent?: number; error?: string },
    ) => listener(payload);
    ipcRenderer.on('update-status', wrapped);
    return () => ipcRenderer.off('update-status', wrapped);
  },
});
