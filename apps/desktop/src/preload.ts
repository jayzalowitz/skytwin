import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload script: exposes a minimal API from the Electron main process
 * to the web renderer via contextBridge.
 */
contextBridge.exposeInMainWorld('skytwinDesktop', {
  /** Check if running inside the desktop app */
  isDesktop: true,

  /** Get service status (API + Worker) */
  getServiceStatus: () => ipcRenderer.invoke('get-service-status'),

  /** Get the app version */
  getVersion: () => ipcRenderer.invoke('get-version'),

  /** Platform info */
  platform: process.platform,
});
