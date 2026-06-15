import { Menu, shell, app, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

// ---------------------------------------------------------------------------
// Native application menu (menu bar) for the SkyTwin desktop app.
//
// Follows the same split as tray.ts: a pure-data template builder
// (`buildAppMenuTemplate`) that takes no Electron API calls and is fully
// unit-testable, plus a thin Electron wrapper (`applyAppMenu`) that converts
// the data template into real Electron menu items and installs it as the
// application menu. The wrapper is NOT unit-tested (it needs a running
// Electron process); tests exercise `buildAppMenuTemplate` directly.
// ---------------------------------------------------------------------------

/** Documentation + issue-tracker URLs surfaced in the Help menu. */
export const DOCUMENTATION_URL = 'https://github.com/jayzalowitz/skytwin#readme';
export const REPORT_ISSUE_URL = 'https://github.com/jayzalowitz/skytwin/issues/new';

/**
 * Named actions a menu item can trigger. Keeping these as a string union
 * (rather than inline click handlers) means the template is plain data —
 * the Electron wrapper maps each action to a concrete handler, exactly the
 * way the tray menu does. Items that use a built-in Electron `role`
 * (copy/paste/minimize/zoom/quit/etc.) carry no action.
 */
export type AppMenuAction =
  | 'show-preferences'
  | 'open-dashboard'
  | 'latest-briefing'
  | 'pause-resume'
  | 'check-for-updates'
  | 'open-documentation'
  | 'report-issue'
  | 'reload'
  | 'toggle-devtools';

/**
 * A single menu item in the platform-agnostic template. Either:
 *   - a `separator`, or
 *   - a `submenu` group (top-level menu bar entries), or
 *   - a leaf item carrying an optional built-in `role` and/or a named `action`.
 *
 * Data only — no Electron API calls and no click closures.
 */
export interface AppMenuItem {
  /** Display label. Omitted for separators and for the macOS app menu (uses app name). */
  label?: string;
  /** A separator line. When true, all other fields are ignored. */
  separator?: boolean;
  /** Built-in Electron role (e.g. 'copy', 'minimize', 'quit'). */
  role?: MenuItemConstructorOptions['role'];
  /** Named SkyTwin action; mapped to a handler by `applyAppMenu`. */
  action?: AppMenuAction;
  /** Keyboard accelerator (e.g. 'CmdOrCtrl+,'). */
  accelerator?: string;
  /** Nested items — present on top-level menu bar entries. */
  submenu?: AppMenuItem[];
}

/** Inputs that change the menu shape. */
export interface AppMenuOptions {
  /** Platform string (process.platform). Drives the macOS app-menu placement. */
  platform: NodeJS.Platform;
  /** Whether the build is packaged (production). Dev-only items (DevTools) are hidden in production. */
  isPackaged: boolean;
  /** Whether the twin is currently paused — flips the "Pause / Resume" label. */
  isPaused: boolean;
}

const sep: AppMenuItem = { separator: true };

/**
 * Build the platform-agnostic application-menu template.
 *
 * macOS gets a leading app menu (bearing the app name) holding
 * About / Preferences / Hide / Quit per Apple HIG; other platforms fold
 * Quit + Preferences into the File menu. Help carries Documentation and
 * Report Issue on every platform. DevTools appears only in non-packaged
 * (development) builds.
 */
export function buildAppMenuTemplate(options: AppMenuOptions): AppMenuItem[] {
  const { platform, isPackaged, isPaused } = options;
  const isMac = platform === 'darwin';

  const template: AppMenuItem[] = [];

  // SkyTwin actions shared between the macOS app menu and the non-mac File menu.
  const skytwinActions: AppMenuItem[] = [
    { label: 'Open Dashboard', action: 'open-dashboard', accelerator: 'CmdOrCtrl+D' },
    { label: 'Latest Briefing', action: 'latest-briefing', accelerator: 'CmdOrCtrl+B' },
    {
      label: isPaused ? 'Resume Twin' : 'Pause Twin',
      action: 'pause-resume',
      accelerator: 'CmdOrCtrl+Shift+P',
    },
  ];

  if (isMac) {
    // macOS app menu — first menu, labelled with the app name automatically.
    template.push({
      label: 'SkyTwin',
      submenu: [
        { role: 'about' },
        // macOS HIG places "Check for Updates…" in the app menu, right under
        // About. Non-mac platforms get it in the Help menu (added below).
        { label: 'Check for Updates…', action: 'check-for-updates' },
        sep,
        { label: 'Preferences…', action: 'show-preferences', accelerator: 'Cmd+,' },
        sep,
        ...skytwinActions,
        sep,
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        sep,
        { role: 'quit' },
      ],
    });
  }

  // File menu. On macOS Quit/Preferences live in the app menu, so File holds
  // the SkyTwin actions; on other platforms File also owns Preferences + Quit.
  const fileSubmenu: AppMenuItem[] = isMac
    ? [...skytwinActions]
    : [
        { label: 'Preferences…', action: 'show-preferences', accelerator: 'Ctrl+,' },
        sep,
        ...skytwinActions,
        sep,
        { role: 'quit' },
      ];
  template.push({ label: 'File', submenu: fileSubmenu });

  // Edit menu — standard built-in roles.
  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      sep,
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  });

  // View menu — Reload always; DevTools only in development builds.
  const viewSubmenu: AppMenuItem[] = [
    { label: 'Reload', action: 'reload', accelerator: 'CmdOrCtrl+R' },
  ];
  if (!isPackaged) {
    viewSubmenu.push({
      label: 'Toggle Developer Tools',
      action: 'toggle-devtools',
      accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
    });
  }
  template.push({ label: 'View', submenu: viewSubmenu });

  // Window menu — standard window roles.
  template.push({
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac ? [sep, { role: 'front' as const }] : [{ role: 'close' as const }]),
    ],
  });

  // Help menu — Documentation + Report Issue on every platform. On non-mac
  // platforms it also carries "Check for Updates…" (macOS keeps that in the
  // app menu per HIG, added above).
  const helpSubmenu: AppMenuItem[] = [
    { label: 'Documentation', action: 'open-documentation' },
    { label: 'Report Issue', action: 'report-issue' },
  ];
  if (!isMac) {
    helpSubmenu.push(sep, { label: 'Check for Updates…', action: 'check-for-updates' });
  }
  template.push({ label: 'Help', submenu: helpSubmenu });

  return template;
}

/** Handlers the Electron wrapper invokes for each named action. */
export interface AppMenuHandlers {
  'show-preferences': () => void;
  'open-dashboard': () => void;
  'latest-briefing': () => void;
  'pause-resume': () => void;
  'check-for-updates': () => void;
  'open-documentation': () => void;
  'report-issue': () => void;
  'reload': () => void;
  'toggle-devtools': () => void;
}

/**
 * Convert an AppMenuItem[] template into Electron MenuItemConstructorOptions[],
 * binding each named action to its handler. Recurses into submenus.
 *
 * Exported for testing the data→Electron mapping shape without installing a
 * real menu. Items with a built-in `role` pass it straight through; named
 * actions become a `click` bound to the matching handler.
 */
export function toElectronTemplate(
  items: AppMenuItem[],
  handlers: AppMenuHandlers,
): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    if (item.separator) {
      return { type: 'separator' };
    }
    const out: MenuItemConstructorOptions = {};
    if (item.label !== undefined) out.label = item.label;
    if (item.role !== undefined) out.role = item.role;
    if (item.accelerator !== undefined) out.accelerator = item.accelerator;
    if (item.action !== undefined) {
      out.click = handlers[item.action];
    }
    if (item.submenu !== undefined) {
      out.submenu = toElectronTemplate(item.submenu, handlers);
    }
    return out;
  });
}

/**
 * Build the application menu from the current options and install it as the
 * global application menu via `Menu.setApplicationMenu`.
 *
 * This wrapper is NOT unit-tested in this PR — it requires a running Electron
 * process. Tests call `buildAppMenuTemplate` / `toElectronTemplate` directly.
 *
 * Navigation actions drive the loaded web dashboard via `executeJavaScript`
 * (the same mechanism the tray uses) so the menu and tray stay consistent.
 */
export function applyAppMenu(
  mainWindow: BrowserWindow,
  options: Pick<AppMenuOptions, 'isPaused'>,
  callbacks: {
    onShowPreferences?: () => void;
    onPauseResume: () => void;
    /** Trigger a manual update check. Omitted in dev builds (no controller). */
    onCheckForUpdates?: () => void;
  },
): void {
  function navigate(hash: string): void {
    if (mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
    // JSON.stringify keeps the hash a valid, injection-safe JS string literal.
    mainWindow.webContents
      .executeJavaScript(`location.hash = ${JSON.stringify(hash)}`)
      .catch(() => {
        /* renderer may have navigated/closed mid-call — ignore */
      });
  }

  const handlers: AppMenuHandlers = {
    'show-preferences': () => {
      if (callbacks.onShowPreferences) {
        callbacks.onShowPreferences();
      } else {
        navigate('#/settings');
      }
    },
    'open-dashboard': () => navigate('#/'),
    'latest-briefing': () => navigate('#/briefing'),
    'pause-resume': () => callbacks.onPauseResume(),
    'check-for-updates': () => callbacks.onCheckForUpdates?.(),
    'open-documentation': () => {
      void shell.openExternal(DOCUMENTATION_URL);
    },
    'report-issue': () => {
      void shell.openExternal(REPORT_ISSUE_URL);
    },
    'reload': () => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.reload();
    },
    'toggle-devtools': () => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.toggleDevTools();
    },
  };

  const template = buildAppMenuTemplate({
    platform: process.platform,
    isPackaged: app.isPackaged,
    isPaused: options.isPaused,
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(toElectronTemplate(template, handlers)));
}
