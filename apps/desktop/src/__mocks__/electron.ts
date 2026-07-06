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

interface NativeImageStub {
  isEmpty(): boolean;
}

interface NativeImageModuleStub {
  createFromDataURL(dataUrl: string): NativeImageStub;
  createFromPath(path: string): NativeImageStub;
}

interface TrayInstanceStub {
  setToolTip(label: string): void;
  setImage(image: unknown): void;
  setContextMenu(menu: unknown): void;
  on(eventName: string, listener: (...args: unknown[]) => void): void;
}

interface TrayConstructorStub {
  new (...args: unknown[]): TrayInstanceStub;
}

interface MenuModuleStub {
  buildFromTemplate(template: unknown[]): { template: unknown[] };
  setApplicationMenu(menu?: unknown): void;
}

interface DialogModuleStub {
  showMessageBox(...args: unknown[]): Promise<{ response: number }>;
}

interface AppModuleStub {
  getVersion(): string;
  quit(): void;
  isPackaged: boolean;
}

interface BrowserWindowInstanceStub {
  show(): void;
  hide(): void;
  focus(): void;
  isVisible(): boolean;
  webContents: { executeJavaScript(script: string): unknown };
  on(eventName: string, listener: (...args: unknown[]) => void): void;
  isQuitting: boolean;
}

interface BrowserWindowConstructorStub {
  new (...args: unknown[]): BrowserWindowInstanceStub;
}

interface IpcMainModuleStub {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void;
  on(channel: string, listener: (...args: unknown[]) => void): void;
}

interface ShellModuleStub {
  openExternal(url: string): Promise<void>;
}

interface SafeStorageModuleStub {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

// nativeImage stub — createFromDataURL returns a trivial object
const nativeImage: NativeImageModuleStub = {
  createFromDataURL: vi.fn(() => ({ isEmpty: () => false })),
  createFromPath: vi.fn(() => ({ isEmpty: () => false })),
};

// Tray stub
const Tray: TrayConstructorStub = vi.fn().mockImplementation(() => ({
  setToolTip: vi.fn(),
  setImage: vi.fn(),
  setContextMenu: vi.fn(),
  on: vi.fn(),
})) as unknown as TrayConstructorStub;

// Menu stub
const Menu: MenuModuleStub = {
  buildFromTemplate: vi.fn((template: unknown[]) => ({ template })),
  setApplicationMenu: vi.fn(),
};

// dialog stub
const dialog: DialogModuleStub = {
  showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
};

// app stub
const app: AppModuleStub = {
  getVersion: vi.fn(() => '0.0.0-test'),
  quit: vi.fn(),
  isPackaged: false,
};

// BrowserWindow stub — only the constructor + methods used by tray.ts
const BrowserWindow: BrowserWindowConstructorStub = vi.fn().mockImplementation(() => ({
  show: vi.fn(),
  hide: vi.fn(),
  focus: vi.fn(),
  isVisible: vi.fn(() => false),
  webContents: { executeJavaScript: vi.fn() },
  on: vi.fn(),
  isQuitting: false,
})) as unknown as BrowserWindowConstructorStub;

// ipcMain stub
const ipcMain: IpcMainModuleStub = {
  handle: vi.fn(),
  on: vi.fn(),
};

// shell stub
const shell: ShellModuleStub = {
  openExternal: vi.fn(() => Promise.resolve()),
};

// safeStorage stub — round-trips with a reversible (NOT secure) transform so
// tests that exercise the passphrase-vault wiring don't need a real keychain.
const safeStorage: SafeStorageModuleStub = {
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
