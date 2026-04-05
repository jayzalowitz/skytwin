import { app, BrowserWindow, ipcMain, type Tray } from 'electron';
import { join } from 'path';
import { ServiceManager } from './service-manager.js';
import { createTray } from './tray.js';
import { getSavedBounds, trackWindowState } from './window-state.js';
import { checkDependencies, showDependencyDialog } from './first-launch.js';

const serviceManager = new ServiceManager();
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

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
    titleBarStyle: 'hiddenInset',
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
ipcMain.handle('pause-twin', async () => {
  await serviceManager.pause();
  return serviceManager.getStatus();
});
ipcMain.handle('resume-twin', async () => {
  await serviceManager.resume();
  return serviceManager.getStatus();
});

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
  serviceManager.stopAll();
});
