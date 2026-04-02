import { app, BrowserWindow, ipcMain, type Tray } from 'electron';
import { join } from 'path';
import { ServiceManager } from './service-manager.js';
import { createTray } from './tray.js';

const serviceManager = new ServiceManager();
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

// Extend BrowserWindow type for our isQuitting flag
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
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
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

  // Load the web dashboard from the API proxy (avoids CORS)
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

async function startApp(): Promise<void> {
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

// App lifecycle
app.whenReady().then(startApp);

app.on('window-all-closed', () => {
  // On macOS, apps stay in the dock
  if (process.platform !== 'darwin') {
    serviceManager.stopAll().then(() => app.quit());
  }
});

app.on('activate', () => {
  // On macOS, re-show the window when clicking the dock icon
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
