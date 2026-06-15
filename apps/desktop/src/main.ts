import { app, BrowserWindow, ipcMain, powerMonitor, safeStorage, shell, type Tray } from 'electron';
import Store from 'electron-store';
import { promises as fs } from 'fs';
import { join } from 'path';
import { ServiceManager } from './service-manager.js';
import {
  PassphraseVault,
  type PassphraseKeyValueStore,
  type SafeStoragePort,
} from './passphrase-vault.js';
import { createTray } from './tray.js';
import { getSavedBounds, trackWindowState } from './window-state.js';
import { checkDependencies, showDependencyDialog } from './first-launch.js';
import { AutoUpdateController, defaultAutoUpdateConfig } from './auto-update.js';
import { IdleBridge, type IdleState, type IdleStateReason } from './idle-bridge.js';
import {
  createFirstCloseToastState,
  shouldShowFirstCloseToast,
  type FirstCloseToastState,
} from './first-close-toast.js';
import { IdlePauseController } from './idle-pause-controller.js';
import {
  getIdlePauseEnabled,
  setIdlePauseEnabled,
  getCrashReportsEnabled,
  setCrashReportsEnabled,
} from './desktop-preferences.js';
import { reportCrash } from './crash-reporter.js';

const serviceManager = new ServiceManager();

// OS-keychain-backed "remember my vault passphrase on this device" store (#401).
// Persists the safeStorage-encrypted passphrase ciphertext in the OS userData
// dir; only decryptable on this machine + user account. See passphrase-vault.ts.
// Cast through the structural ports for the same reason desktop-preferences.ts
// does — electron-store's ESM Conf inheritance doesn't survive `module: commonjs`.
const passphraseStore = new Store<Record<string, string>>({
  name: 'skytwin-passphrase-vault',
}) as unknown as PassphraseKeyValueStore;
const passphraseVault = new PassphraseVault(
  safeStorage as unknown as SafeStoragePort,
  passphraseStore,
);

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let updateController: AutoUpdateController | null = null;
let idleBridge: IdleBridge | null = null;
const firstCloseToastState: FirstCloseToastState = createFirstCloseToastState();
const idlePauseController = new IdlePauseController({
  getEnabled: () => getIdlePauseEnabled(),
  isCurrentlyPaused: () => serviceManager.isPaused(),
  pauseServices: () => serviceManager.pause(),
  resumeServices: () => serviceManager.resume(),
});

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

  // Close button hides to tray rather than quitting — the app keeps
  // running so it can act on signals. First-time close fires a toast
  // explaining this so the user doesn't think the app died.
  //
  // Destroyed-webContents guard runs BEFORE the state-machine check
  // so we don't flip "shown=true" on a dispatch that never happens —
  // otherwise a race during shutdown would burn the one-shot for the
  // session and the toast would never appear.
  win.on('close', (event) => {
    if (!win.isQuitting) {
      event.preventDefault();
      if (!win.webContents.isDestroyed() && shouldShowFirstCloseToast(firstCloseToastState)) {
        try {
          win.webContents.send('show-first-close-toast');
        } catch {
          // send() can throw if the renderer crashed between the
          // isDestroyed check and now. Swallow — losing the toast
          // is preferable to crashing the main process during close.
        }
      }
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

  // Wire first-launch extraction progress (#383) so the splash shows
  // a real progress bar instead of a spinner. The splash's
  // window.setExtractionProgress(percent, label) is defined in
  // splash.html; we drive it via executeJavaScript so the splash
  // doesn't need its own preload script.
  serviceManager.setExtractProgressHandler((progress) => {
    const splash = splashWindow;
    if (!splash || splash.isDestroyed() || splash.webContents.isDestroyed()) return;
    // Single-quote-safe JSON encoding of the label, then call into
    // the splash's renderer. JSON.stringify gives a valid JS literal
    // for any UTF-8 string (escapes embedded quotes and newlines).
    const labelJs = JSON.stringify(progress.label);
    splash.webContents
      .executeJavaScript(
        `window.setExtractionProgress && window.setExtractionProgress(${progress.percent}, ${labelJs})`,
      )
      .catch(() => { /* splash may have closed mid-update — ignore */ });
  });

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
  // Hand the transition to the idle-pause controller. It decides
  // whether to pause / resume the worker based on the user's
  // "pause when idle" preference and whether the user has already
  // manually paused (#382). Fire-and-forget — pause/resume are
  // sequenced by the controller; surfacing errors here would mean
  // a renderer toast for a background concern.
  void idlePauseController.onIdleStateChange(state).catch((err) => {
    console.warn('[idle-pause] action failed', err);
  });
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
  // User-initiated pause — clear the controller's auto-paused flag so
  // a subsequent "active" event doesn't auto-resume the user's choice.
  idlePauseController.onManualPauseChange();
  await serviceManager.pause();
  return serviceManager.getStatus();
});
ipcMain.handle('resume-twin', async () => {
  // Same idea on the resume side: this is the user reasserting they
  // want the twin running. If they then sit idle, the next idle event
  // (or the next poll tick from idle-bridge) will re-evaluate cleanly.
  idlePauseController.onManualPauseChange();
  await serviceManager.resume();
  return serviceManager.getStatus();
});

ipcMain.handle('get-idle-pause-enabled', () => getIdlePauseEnabled());
ipcMain.handle('set-idle-pause-enabled', async (_event, enabled: boolean) => {
  const value = enabled === true;
  setIdlePauseEnabled(value);
  // If the user just turned the setting off while we're auto-paused,
  // resume immediately so the toggle has an observable effect.
  await idlePauseController.onEnabledChanged(value).catch((err) => {
    console.warn('[idle-pause] onEnabledChanged failed', err);
  });
  return value;
});

ipcMain.handle('get-crash-reports-enabled', () => getCrashReportsEnabled());
ipcMain.handle('set-crash-reports-enabled', (_event, enabled: boolean) => {
  const value = enabled === true;
  setCrashReportsEnabled(value);
  return value;
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

// ── Credential-vault passphrase remember-on-device (#401) ────────────────────
// Lets the renderer optionally cache the vault passphrase in the OS keychain so
// a relaunch can auto-unlock. Plaintext never crosses the bridge to disk — the
// main process encrypts via safeStorage before persisting. Unsupported
// environments degrade gracefully (the renderer hides the prompt and keeps the
// per-session passphrase behavior).
ipcMain.handle('vault-passphrase-supported', () => passphraseVault.isSupported());

ipcMain.handle('vault-passphrase-remember', (_event, userId: string, passphrase: string) => {
  if (typeof userId !== 'string' || userId === '') {
    return { ok: false, reason: 'empty_passphrase' as const };
  }
  if (typeof passphrase !== 'string') {
    return { ok: false, reason: 'empty_passphrase' as const };
  }
  return passphraseVault.remember(userId, passphrase);
});

ipcMain.handle('vault-passphrase-get', (_event, userId: string) => {
  if (typeof userId !== 'string' || userId === '') {
    return { ok: false, reason: 'not_found' as const };
  }
  return passphraseVault.getRemembered(userId);
});

ipcMain.handle('vault-passphrase-has', (_event, userId: string) => {
  if (typeof userId !== 'string' || userId === '') return false;
  return passphraseVault.has(userId);
});

ipcMain.handle('vault-passphrase-forget', (_event, userId: string) => {
  if (typeof userId === 'string' && userId !== '') passphraseVault.forget(userId);
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

/**
 * Install process-level crash handlers (#399). They re-check the opt-in
 * preference on every crash (not just at install time) so toggling the
 * setting takes effect without a relaunch, and `reportCrash` gates the
 * send on it a second time. We log the crash regardless of the setting —
 * the toggle controls only whether a report leaves the machine.
 */
function installCrashHandlers(): void {
  const buildContext = (
    kind: 'uncaughtException' | 'unhandledRejection',
  ) => ({
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    kind,
  });

  process.on('uncaughtException', (err) => {
    console.error('[crash] uncaughtException', err);
    void reportCrash({
      enabled: getCrashReportsEnabled(),
      thrown: err,
      context: buildContext('uncaughtException'),
    }).catch(() => {
      /* reporting must never throw out of the crash handler */
    });
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[crash] unhandledRejection', reason);
    void reportCrash({
      enabled: getCrashReportsEnabled(),
      thrown: reason,
      context: buildContext('unhandledRejection'),
    }).catch(() => {
      /* reporting must never throw out of the crash handler */
    });
  });
}

installCrashHandlers();

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
