import Store from 'electron-store';
import type { BrowserWindow } from 'electron';

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

// electron-store v11 inherits .get/.set from the ESM-only Conf class.
// Under `module: commonjs` in this app's tsconfig TS can't resolve the
// type extension chain, so the methods come back as missing even though
// they exist at runtime. Narrow to a small structural surface that
// matches what we actually use — easier to audit than a blanket cast,
// and the constructor + runtime call sites stay unchanged.
type WindowBoundsStore = {
  get(key: 'windowBounds'): WindowBounds;
  set(key: 'windowBounds', value: WindowBounds): void;
  set(key: 'windowBounds.isMaximized', value: boolean): void;
};

const store = new Store<{ windowBounds: WindowBounds }>({
  name: 'skytwin-window-state',
  defaults: {
    windowBounds: {
      x: undefined as unknown as number,
      y: undefined as unknown as number,
      width: 1200,
      height: 800,
      isMaximized: false,
    },
  },
}) as unknown as WindowBoundsStore;

/**
 * Returns saved window bounds for creating the BrowserWindow.
 */
export function getSavedBounds(): Partial<WindowBounds> {
  const saved = store.get('windowBounds');
  return {
    width: saved.width || 1200,
    height: saved.height || 800,
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    isMaximized: saved.isMaximized || false,
  };
}

/**
 * Tracks and persists window position/size across sessions.
 */
export function trackWindowState(win: BrowserWindow): void {
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;

  function saveBounds(): void {
    if (win.isDestroyed()) return;
    const isMaximized = win.isMaximized();
    if (!isMaximized) {
      const bounds = win.getBounds();
      store.set('windowBounds', { ...bounds, isMaximized });
    } else {
      store.set('windowBounds.isMaximized', true);
    }
  }

  function debouncedSave(): void {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveBounds, 300);
  }

  win.on('resize', debouncedSave);
  win.on('move', debouncedSave);
  win.on('maximize', () => store.set('windowBounds.isMaximized', true));
  win.on('unmaximize', debouncedSave);
}
