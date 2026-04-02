import { Tray, Menu, nativeImage, type BrowserWindow } from 'electron';
import type { ServiceManager } from './service-manager.js';

/**
 * Creates and manages the system tray icon and menu.
 */
export function createTray(
  mainWindow: BrowserWindow,
  serviceManager: ServiceManager,
): Tray {
  // Create a simple tray icon (16x16 data URI — blue circle)
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA' +
    'P0lEQVQ4T2NkoBAwUqifgWoGMIIMMDAw/Mcw4D8DA8N/BgYGRkYGhv+MDAwMjCCaAewA' +
    'opzAQB0X0NwFVDMAALHkCBHwPAgqAAAAAElFTkSuQmCC',
  );

  const tray = new Tray(icon);
  tray.setToolTip('SkyTwin — Your AI Assistant');

  function updateMenu(): void {
    const status = serviceManager.getStatus();
    const apiLabel = status.api === 'running' ? 'API: Running' :
      status.api === 'error' ? 'API: Error' : 'API: Stopped';
    const workerLabel = status.worker === 'running' ? 'Worker: Running' :
      status.worker === 'error' ? 'Worker: Error' : 'Worker: Stopped';

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open SkyTwin',
        click: () => {
          mainWindow.show();
          mainWindow.focus();
        },
      },
      { type: 'separator' },
      {
        label: 'Services',
        submenu: [
          { label: apiLabel, enabled: false },
          { label: workerLabel, enabled: false },
        ],
      },
      { type: 'separator' },
      {
        label: 'Quit SkyTwin',
        click: () => {
          (mainWindow as unknown as { isQuitting: boolean }).isQuitting = true;
          serviceManager.stopAll().then(() => {
            const { app } = require('electron');
            app.quit();
          });
        },
      },
    ]);
    tray.setContextMenu(contextMenu);
  }

  // Update menu when service status changes
  serviceManager.setStatusHandler(() => updateMenu());
  updateMenu();

  // Click on tray icon shows the window
  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  return tray;
}
