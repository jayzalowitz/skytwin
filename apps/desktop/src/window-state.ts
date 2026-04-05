import Store from 'electron-store';
import type { BrowserWindow } from 'electron';

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

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
});

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
