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

  /** Open a URL in the system default browser (used for OAuth) */
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

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
});
