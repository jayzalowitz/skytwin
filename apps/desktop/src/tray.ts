import { Tray, Menu, nativeImage, dialog, app, type BrowserWindow } from 'electron';
import type { ServiceManager, ServiceStatus } from './service-manager.js';

// ---------------------------------------------------------------------------
// Pure-data tray menu types and builder (no Electron API calls).
// These are testable without spawning an Electron process.
// ---------------------------------------------------------------------------

/** The runtime state exposed to the tray menu builder. */
export interface TrayState {
  state: 'idle' | 'scanning' | 'acting' | 'paused';
}

/** A single item in the tray menu (data only — no click handlers). */
export interface TrayMenuItem {
  label: string;
  action: 'open-main' | 'pause-everything' | 'latest-briefing' | 'quit';
  enabled: boolean;
}

/**
 * Build a platform-agnostic tray menu from the current TrayState.
 *
 * Returns a plain array of TrayMenuItem objects with no Electron API calls.
 * The "Pause" item becomes "Resume" when the state is already 'paused', and
 * is disabled while a scan or action is in flight ('scanning' / 'acting').
 *
 * The thin Electron wrapper `applyTrayMenu` (below) turns these into real
 * Electron menu items — it is NOT tested in this PR.
 */
export function buildTrayMenuItems(state: TrayState): TrayMenuItem[] {
  const isPaused = state.state === 'paused';
  const isBusy = state.state === 'scanning' || state.state === 'acting';

  return [
    {
      label: 'Open Dashboard',
      action: 'open-main',
      enabled: true,
    },
    {
      label: isPaused ? 'Resume Everything' : 'Pause Everything',
      action: 'pause-everything',
      // Disable during active scan/act — let the in-flight operation finish first.
      enabled: !isBusy,
    },
    {
      label: 'Latest Briefing',
      action: 'latest-briefing',
      enabled: true,
    },
    {
      label: 'Quit SkyTwin',
      action: 'quit',
      enabled: true,
    },
  ];
}

/**
 * Thin wrapper that converts TrayMenuItem[] into real Electron menu items and
 * attaches them to an Electron Tray instance.
 *
 * This wrapper is NOT tested in this PR — it requires Electron to be running.
 * Tests should call buildTrayMenuItems directly.
 */
export function applyTrayMenu(
  trayInstance: Tray,
  items: TrayMenuItem[],
  handlers: {
    'open-main': () => void;
    'pause-everything': () => void;
    'latest-briefing': () => void;
    'quit': () => void;
  },
): void {
  const template = items.map((item) => ({
    label: item.label,
    enabled: item.enabled,
    click: handlers[item.action],
  }));
  trayInstance.setContextMenu(Menu.buildFromTemplate(template));
}

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
