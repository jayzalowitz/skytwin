import { Tray, Menu, nativeImage, dialog, app, type BrowserWindow } from 'electron';
import type { ServiceManager, ServiceStatus } from './service-manager.js';

// 16x16 colored circle icons (PNG base64)
const ICON_GREEN = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA' +
  'QUlEQVQ4T2NkoBAwUqifYdAYwMjAwPCfgYGBkYGBgZGRgYERRDMwMDCAaIa/DAz/QRz/' +
  'DAwM/xkZGP4zUOoCACdICBEJ+vUOAAAAAElFTkSuQmCC',
);

const ICON_YELLOW = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA' +
  'QElEQVQ4T2NkoBAwUqifYdAY8J+BgYGRkYHhPyMDAwMjAwMDIyMDA4hmYGBgANEM/xgY' +
  '/oM4/v8zMPxnoNQFAJ7YCBG/HkPdAAAAAElFTkSuQmCC',
);

const ICON_RED = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA' +
  'QUlEQVQ4T2NkoBAwUqifYdAYwMjAwPCfgYGBkYGBgZGRgYERRDMwMDCAaIa/DAz/QZz/' +
  'DAwM/xkZGP4zUOoCACjnCBHJcvMFAAAAAElFTkSuQmCC',
);

function getIcon(overall: ServiceStatus['overall']): Electron.NativeImage {
  switch (overall) {
    case 'healthy': return ICON_GREEN;
    case 'degraded': return ICON_YELLOW;
    case 'failed': return ICON_RED;
  }
}

function statusLabel(state: string): string {
  const labels: Record<string, string> = {
    running: 'Running',
    stopped: 'Stopped',
    starting: 'Starting...',
    error: 'Error',
    paused: 'Paused',
  };
  return labels[state] || state;
}

/**
 * Creates and manages the system tray icon and menu.
 * Tray icon color reflects overall health:
 *   green = healthy, yellow = degraded, red = failed
 */
export function createTray(
  mainWindow: BrowserWindow,
  serviceManager: ServiceManager,
): Tray {
  const tray = new Tray(ICON_GREEN);
  tray.setToolTip('SkyTwin — Your AI Assistant');

  function updateMenu(): void {
    const status = serviceManager.getStatus();

    // Update tray icon color
    tray.setImage(getIcon(status.overall));

    const isPaused = serviceManager.isPaused();

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open Dashboard',
        click: () => {
          mainWindow.show();
          mainWindow.focus();
        },
      },
      { type: 'separator' },
      {
        label: isPaused ? 'Resume Twin' : 'Pause Twin',
        click: async () => {
          if (isPaused) {
            await serviceManager.resume();
          } else {
            await serviceManager.pause();
          }
          updateMenu();
        },
      },
      { type: 'separator' },
      {
        label: 'Services',
        submenu: [
          { label: `API: ${statusLabel(status.api)}`, enabled: false },
          { label: `Worker: ${statusLabel(status.worker)}`, enabled: false },
        ],
      },
      { type: 'separator' },
      {
        label: 'About SkyTwin',
        click: () => showAbout(serviceManager),
      },
      {
        label: 'Settings',
        click: () => {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.executeJavaScript("location.hash = '#/settings'");
        },
      },
      { type: 'separator' },
      {
        label: 'Quit SkyTwin',
        click: () => {
          (mainWindow as unknown as { isQuitting: boolean }).isQuitting = true;
          serviceManager.stopAll().then(() => {
            app.quit();
          });
        },
      },
    ]);
    tray.setContextMenu(contextMenu);
  }

  // Update menu and icon when service status changes
  serviceManager.setStatusHandler((status) => {
    updateMenu();

    // Show alert dialog when a service enters 'failed' state
    if (status.overall === 'failed') {
      dialog.showMessageBox({
        type: 'error',
        title: 'SkyTwin Service Failure',
        message: 'SkyTwin services failed to start',
        detail: `API: ${statusLabel(status.api)}\nWorker: ${statusLabel(status.worker)}\n\nCheck the logs for details. You may need to restart the application.`,
        buttons: ['OK'],
      });
    }
  });

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

async function showAbout(serviceManager: ServiceManager): Promise<void> {
  const status = serviceManager.getStatus();
  const uptime = serviceManager.getUptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const uptimeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  await dialog.showMessageBox({
    type: 'info',
    title: 'About SkyTwin',
    message: `SkyTwin Desktop v${app.getVersion()}`,
    detail: [
      `Uptime: ${uptimeStr}`,
      `API: ${statusLabel(status.api)}`,
      `Worker: ${statusLabel(status.worker)}`,
      `Overall: ${status.overall}`,
      '',
      'Your personal AI assistant that learns',
      'how you handle things and acts on your behalf.',
    ].join('\n'),
    buttons: ['OK'],
  });
}
