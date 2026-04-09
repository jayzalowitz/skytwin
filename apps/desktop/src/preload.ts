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
});
