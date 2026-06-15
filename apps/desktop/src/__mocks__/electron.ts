/**
 * Minimal Electron stub for unit tests.
 *
 * Tests that import tray.ts (which calls nativeImage.createFromDataURL at
 * module load time) would crash without this stub because nativeImage only
 * exists inside a real Electron process. This stub satisfies the import so
 * the pure-data functions (buildTrayMenuItems, etc.) can be exercised without
 * spawning Electron.
 *
 * Only the symbols actually used by tray.ts and main.ts at module-load time
 * need to be stubbed — everything else can remain undefined.
 */

import { vi } from 'vitest';

// nativeImage stub — createFromDataURL returns a trivial object
const nativeImage = {
  createFromDataURL: vi.fn(() => ({ isEmpty: () => false })),
  createFromPath: vi.fn(() => ({ isEmpty: () => false })),
};

// Tray stub
const Tray = vi.fn().mockImplementation(() => ({
  setToolTip: vi.fn(),
  setImage: vi.fn(),
  setContextMenu: vi.fn(),
  on: vi.fn(),
}));

// Menu stub
const Menu = {
  buildFromTemplate: vi.fn((template: unknown[]) => ({ template })),
  setApplicationMenu: vi.fn(),
};

// dialog stub
const dialog = {
  showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
};

// app stub
const app = {
  getVersion: vi.fn(() => '0.0.0-test'),
  quit: vi.fn(),
  isPackaged: false,
};

// BrowserWindow stub — only the constructor + methods used by tray.ts
const BrowserWindow = vi.fn().mockImplementation(() => ({
  show: vi.fn(),
  hide: vi.fn(),
  focus: vi.fn(),
  isVisible: vi.fn(() => false),
  webContents: { executeJavaScript: vi.fn() },
  on: vi.fn(),
  isQuitting: false,
}));

// ipcMain stub
const ipcMain = {
  handle: vi.fn(),
  on: vi.fn(),
};

// shell stub
const shell = {
  openExternal: vi.fn(() => Promise.resolve()),
};

// safeStorage stub — round-trips with a reversible (NOT secure) transform so
// tests that exercise the passphrase-vault wiring don't need a real keychain.
const safeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((plaintext: string) => Buffer.from(plaintext, 'utf8')),
  decryptString: vi.fn((ciphertext: Buffer) => ciphertext.toString('utf8')),
};

export {
  nativeImage,
  Tray,
  Menu,
  dialog,
  app,
  BrowserWindow,
  ipcMain,
  shell,
  safeStorage,
};
