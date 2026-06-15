import { describe, it, expect, vi } from 'vitest';
import {
  buildAppMenuTemplate,
  toElectronTemplate,
  DOCUMENTATION_URL,
  REPORT_ISSUE_URL,
  type AppMenuItem,
  type AppMenuHandlers,
  type AppMenuOptions,
} from '../app-menu.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function topLevelLabels(template: AppMenuItem[]): string[] {
  return template.filter((i) => i.label !== undefined).map((i) => i.label!);
}

function menuByLabel(template: AppMenuItem[], label: string): AppMenuItem | undefined {
  return template.find((i) => i.label === label);
}

function findAction(items: AppMenuItem[], action: string): AppMenuItem | undefined {
  for (const item of items) {
    if (item.action === action) return item;
    if (item.submenu) {
      const nested = findAction(item.submenu, action);
      if (nested) return nested;
    }
  }
  return undefined;
}

function hasRole(items: AppMenuItem[], role: string): boolean {
  for (const item of items) {
    if (item.role === role) return true;
    if (item.submenu && hasRole(item.submenu, role)) return true;
  }
  return false;
}

const macDev: AppMenuOptions = { platform: 'darwin', isPackaged: false, isPaused: false };
const macProd: AppMenuOptions = { platform: 'darwin', isPackaged: true, isPaused: false };
const winDev: AppMenuOptions = { platform: 'win32', isPackaged: false, isPaused: false };
const winProd: AppMenuOptions = { platform: 'win32', isPackaged: true, isPaused: false };

// ---------------------------------------------------------------------------
// buildAppMenuTemplate — structure
// ---------------------------------------------------------------------------

describe('buildAppMenuTemplate — macOS structure', () => {
  const template = buildAppMenuTemplate(macDev);

  it('leads with the SkyTwin app menu on macOS', () => {
    expect(template[0].label).toBe('SkyTwin');
  });

  it('includes File, Edit, View, Window, Help menus', () => {
    const labels = topLevelLabels(template);
    for (const m of ['SkyTwin', 'File', 'Edit', 'View', 'Window', 'Help']) {
      expect(labels).toContain(m);
    }
  });

  it('app menu holds about, preferences, hide, and quit', () => {
    const appMenu = menuByLabel(template, 'SkyTwin')!;
    expect(hasRole(appMenu.submenu!, 'about')).toBe(true);
    expect(hasRole(appMenu.submenu!, 'hide')).toBe(true);
    expect(hasRole(appMenu.submenu!, 'quit')).toBe(true);
    expect(findAction(appMenu.submenu!, 'show-preferences')).toBeDefined();
  });

  it('File menu does NOT duplicate Quit on macOS (lives in app menu)', () => {
    const fileMenu = menuByLabel(template, 'File')!;
    expect(hasRole(fileMenu.submenu!, 'quit')).toBe(false);
  });
});

describe('buildAppMenuTemplate — non-macOS structure', () => {
  const template = buildAppMenuTemplate(winDev);

  it('does NOT have a leading app menu on Windows/Linux', () => {
    expect(template[0].label).toBe('File');
  });

  it('File menu owns Preferences and Quit on non-mac', () => {
    const fileMenu = menuByLabel(template, 'File')!;
    expect(findAction(fileMenu.submenu!, 'show-preferences')).toBeDefined();
    expect(hasRole(fileMenu.submenu!, 'quit')).toBe(true);
  });

  it('includes File, Edit, View, Window, Help', () => {
    const labels = topLevelLabels(template);
    for (const m of ['File', 'Edit', 'View', 'Window', 'Help']) {
      expect(labels).toContain(m);
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance criteria — required items present
// ---------------------------------------------------------------------------

describe('buildAppMenuTemplate — Edit menu (standard roles)', () => {
  it('has cut/copy/paste/selectAll/undo/redo', () => {
    const template = buildAppMenuTemplate(macDev);
    const edit = menuByLabel(template, 'Edit')!;
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) {
      expect(hasRole(edit.submenu!, role)).toBe(true);
    }
  });
});

describe('buildAppMenuTemplate — View menu (Reload + dev-only DevTools)', () => {
  it('always exposes Reload', () => {
    const view = menuByLabel(buildAppMenuTemplate(macDev), 'View')!;
    expect(findAction(view.submenu!, 'reload')).toBeDefined();
  });

  it('shows Toggle Developer Tools in development builds', () => {
    const view = menuByLabel(buildAppMenuTemplate(macDev), 'View')!;
    expect(findAction(view.submenu!, 'toggle-devtools')).toBeDefined();
  });

  it('HIDES Toggle Developer Tools in packaged (production) builds', () => {
    const viewMac = menuByLabel(buildAppMenuTemplate(macProd), 'View')!;
    const viewWin = menuByLabel(buildAppMenuTemplate(winProd), 'View')!;
    expect(findAction(viewMac.submenu!, 'toggle-devtools')).toBeUndefined();
    expect(findAction(viewWin.submenu!, 'toggle-devtools')).toBeUndefined();
    // Reload still present in production.
    expect(findAction(viewMac.submenu!, 'reload')).toBeDefined();
  });
});

describe('buildAppMenuTemplate — Window menu', () => {
  it('has Minimize and Zoom', () => {
    const win = menuByLabel(buildAppMenuTemplate(macDev), 'Window')!;
    expect(hasRole(win.submenu!, 'minimize')).toBe(true);
    expect(hasRole(win.submenu!, 'zoom')).toBe(true);
  });
});

describe('buildAppMenuTemplate — Help menu', () => {
  it('has Documentation and Report Issue on every platform', () => {
    for (const opts of [macDev, winDev]) {
      const help = menuByLabel(buildAppMenuTemplate(opts), 'Help')!;
      const doc = findAction(help.submenu!, 'open-documentation');
      const issue = findAction(help.submenu!, 'report-issue');
      expect(doc?.label).toBe('Documentation');
      expect(issue?.label).toBe('Report Issue');
    }
  });
});

describe('buildAppMenuTemplate — SkyTwin actions', () => {
  it('exposes Open Dashboard, Latest Briefing, Pause Twin', () => {
    const template = buildAppMenuTemplate(macDev);
    expect(findAction(template, 'open-dashboard')).toBeDefined();
    expect(findAction(template, 'latest-briefing')).toBeDefined();
    expect(findAction(template, 'pause-resume')).toBeDefined();
  });

  it('Pause label reads "Pause Twin" when running', () => {
    const item = findAction(buildAppMenuTemplate({ ...macDev, isPaused: false }), 'pause-resume')!;
    expect(item.label).toBe('Pause Twin');
  });

  it('Pause label reads "Resume Twin" when paused', () => {
    const item = findAction(buildAppMenuTemplate({ ...macDev, isPaused: true }), 'pause-resume')!;
    expect(item.label).toBe('Resume Twin');
  });
});

// ---------------------------------------------------------------------------
// toElectronTemplate — data → Electron mapping
// ---------------------------------------------------------------------------

function makeHandlers(): { handlers: AppMenuHandlers; spies: Record<string, ReturnType<typeof vi.fn>> } {
  const spies: Record<string, ReturnType<typeof vi.fn>> = {
    'show-preferences': vi.fn(),
    'open-dashboard': vi.fn(),
    'latest-briefing': vi.fn(),
    'pause-resume': vi.fn(),
    'open-documentation': vi.fn(),
    'report-issue': vi.fn(),
    'reload': vi.fn(),
    'toggle-devtools': vi.fn(),
  };
  return { handlers: spies as unknown as AppMenuHandlers, spies };
}

describe('toElectronTemplate', () => {
  it('maps separators to { type: "separator" }', () => {
    const { handlers } = makeHandlers();
    const out = toElectronTemplate([{ separator: true }], handlers);
    expect(out[0]).toEqual({ type: 'separator' });
  });

  it('passes built-in roles straight through', () => {
    const { handlers } = makeHandlers();
    const out = toElectronTemplate([{ role: 'copy' }], handlers);
    expect(out[0].role).toBe('copy');
    expect(out[0].click).toBeUndefined();
  });

  it('binds named actions to the matching handler click', () => {
    const { handlers, spies } = makeHandlers();
    const out = toElectronTemplate(
      [{ label: 'Documentation', action: 'open-documentation' }],
      handlers,
    );
    expect(typeof out[0].click).toBe('function');
    (out[0].click as () => void)();
    expect(spies['open-documentation']).toHaveBeenCalledTimes(1);
  });

  it('recurses into submenus', () => {
    const { handlers, spies } = makeHandlers();
    const out = toElectronTemplate(
      [{ label: 'Help', submenu: [{ label: 'Report Issue', action: 'report-issue' }] }],
      handlers,
    );
    const sub = out[0].submenu as Array<{ click?: () => void }>;
    expect(typeof sub[0].click).toBe('function');
    sub[0].click!();
    expect(spies['report-issue']).toHaveBeenCalledTimes(1);
  });

  it('preserves accelerators', () => {
    const { handlers } = makeHandlers();
    const out = toElectronTemplate(
      [{ label: 'Preferences…', action: 'show-preferences', accelerator: 'Cmd+,' }],
      handlers,
    );
    expect(out[0].accelerator).toBe('Cmd+,');
  });

  it('converts a full mac template end-to-end without throwing', () => {
    const { handlers } = makeHandlers();
    const out = toElectronTemplate(buildAppMenuTemplate(macDev), handlers);
    expect(out.length).toBeGreaterThan(0);
    const labels = out.map((i) => i.label);
    expect(labels).toContain('SkyTwin');
    expect(labels).toContain('Help');
  });
});

// ---------------------------------------------------------------------------
// URL constants
// ---------------------------------------------------------------------------

describe('Help URLs', () => {
  it('point at the GitHub repo and are https', () => {
    expect(DOCUMENTATION_URL).toMatch(/^https:\/\/github\.com\/jayzalowitz\/skytwin/);
    expect(REPORT_ISSUE_URL).toMatch(/^https:\/\/github\.com\/jayzalowitz\/skytwin\/issues/);
  });
});
