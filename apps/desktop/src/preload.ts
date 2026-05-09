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
});
