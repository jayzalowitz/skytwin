import { app, BrowserWindow, ipcMain, powerMonitor, shell, type Tray } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { ServiceManager } from './service-manager.js';
import { createTray } from './tray.js';
import { getSavedBounds, trackWindowState } from './window-state.js';
import { checkDependencies, showDependencyDialog } from './first-launch.js';
import { AutoUpdateController, defaultAutoUpdateConfig } from './auto-update.js';
import { IdleBridge, type IdleState, type IdleStateReason } from './idle-bridge.js';

const serviceManager = new ServiceManager();
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let updateController: AutoUpdateController | null = null;
let idleBridge: IdleBridge | null = null;

declare module 'electron' {
  interface BrowserWindow {
    isQuitting?: boolean;
  }
}

function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 400,
    height: 320,
    frame: false,
    transparent: false,
    resizable: false,
    alwaysOnTop: true,
    backgroundColor: '#09090b',
  });

  splash.loadFile(join(__dirname, '..', 'src', 'splash.html'));
  return splash;
}

function createMainWindow(): BrowserWindow {
  const saved = getSavedBounds();

  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 800,
    minHeight: 600,
    show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    backgroundColor: '#09090b',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Restore maximized state
  if (saved.isMaximized) {
    win.maximize();
  }

  // Track window state for persistence
  trackWindowState(win);

  // Load the web dashboard
  win.loadURL('http://localhost:3200');

  // On macOS, clicking the close button minimizes to tray
  win.on('close', (event) => {
    if (!win.isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  return win;
}

async function runFirstLaunchChecks(): Promise<boolean> {
  const missing = checkDependencies();
  if (missing.length > 0) {
    const resolved = await showDependencyDialog(missing);
    if (!resolved) {
      app.quit();
      return false;
    }
  }
  return true;
}

async function startApp(): Promise<void> {
  // First-launch dependency check
  const depsOk = await runFirstLaunchChecks();
  if (!depsOk) return;

  // Show splash screen
  splashWindow = createSplashWindow();

  // Create main window (hidden)
  mainWindow = createMainWindow();

  // Set up tray
  tray = createTray(mainWindow, serviceManager);

  // Start services
  try {
    await serviceManager.startAll();
  } catch (err) {
    console.error('Failed to start services:', err);
  }

  // Wait for web server to be ready
  const webReady = await waitForWeb(15000);
  if (webReady) {
    mainWindow.loadURL('http://localhost:3200');
  }

  // Show main window, close splash
  mainWindow.show();
  mainWindow.focus();
  splashWindow?.close();
  splashWindow = null;

  // If a .dxt file was double-clicked before the window finished loading,
  // the open-file event fired into pendingDxtPath. Drain it now.
  mainWindow.webContents.once('did-finish-load', forwardPendingDxtPathIfReady);

  // Wire auto-update only for packaged (production) builds.
  // Skipped in dev mode to avoid noisy update checks against GitHub Releases
  // during local development where the version may lag the published channel.
  if (app.isPackaged) {
    updateController = new AutoUpdateController(defaultAutoUpdateConfig());
    updateController.schedulePeriodicChecks();
    console.info('[auto-update] Periodic update checks scheduled.');
  }

  idleBridge = new IdleBridge({
    powerMonitor,
    onStateChange: handleIdleStateChange,
  });
  idleBridge.start();
}

function handleIdleStateChange(state: IdleState, reason: IdleStateReason): void {
  console.info(`[idle-bridge] state=${state} reason=${reason}`);
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('idle-state-changed', { state, reason });
  }
}

async function waitForWeb(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch('http://localhost:3200');
      if (response.ok) return true;
    } catch {
      // Web server not ready
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// IPC handlers
ipcMain.handle('get-service-status', () => serviceManager.getStatus());
ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('get-launch-at-login', () => {
  const settings = app.getLoginItemSettings();
  return settings.openAtLogin;
});
ipcMain.handle('set-launch-at-login', (_event, enabled: boolean) => {
  app.setLoginItemSettings({ openAtLogin: enabled });
  return enabled;
});
ipcMain.handle('open-external', async (_event, url: string) => {
  // Only allow http/https URLs to prevent shell injection
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    await shell.openExternal(url);
  }
});
ipcMain.handle('pause-twin', async () => {
  await serviceManager.pause();
  return serviceManager.getStatus();
});
ipcMain.handle('resume-twin', async () => {
  await serviceManager.resume();
  return serviceManager.getStatus();
});

ipcMain.handle('read-dxt-file', async (_event, filePath: string) => {
  if (typeof filePath !== 'string' || filePath === '') {
    throw new Error('filePath required');
  }
  const lower = filePath.toLowerCase();
  if (!lower.endsWith('.dxt') && !lower.endsWith('.json')) {
    throw new Error('only .dxt or .json files are accepted');
  }
  const data = await fs.readFile(filePath);
  return { name: filePath.split(/[\\/]/).pop() ?? 'artifact.dxt', base64: data.toString('base64') };
});

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  pendingDxtPath = filePath;
  forwardPendingDxtPathIfReady();
});

let pendingDxtPath: string | null = null;
function forwardPendingDxtPathIfReady(): void {
  if (pendingDxtPath === null) return;
  if (mainWindow === null || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return;
  mainWindow.webContents.send('dxt-file-opened', { path: pendingDxtPath });
  pendingDxtPath = null;
}

// Single-instance lock. Without this, a second launch (double-click in the
// dock, login-item + manual click, etc.) would race CockroachManager.start()
// against the running instance — both see "port not bound yet," both spawn
// `cockroach start-single-node --store=<userData>/crdb-data`, the loser hits
// CRDB's data-dir LOCK file with a cryptic error, and from the user's POV
// nothing happens. Reject the second instance early and surface the existing
// window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// App lifecycle
app.whenReady().then(startApp);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    serviceManager.stopAll().then(() => app.quit());
  }
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', () => {
  if (mainWindow) {
    mainWindow.isQuitting = true;
  }
  updateController?.cancelScheduledChecks();
  idleBridge?.stop();
  serviceManager.stopAll();
});
