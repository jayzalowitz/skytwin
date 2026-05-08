import { describe, it, expect } from 'vitest';
import { buildTrayMenuItems } from '../tray.js';
import type { TrayState, TrayMenuItem } from '../tray.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function itemByAction(
  items: TrayMenuItem[],
  action: TrayMenuItem['action'],
): TrayMenuItem | undefined {
  return items.find((i) => i.action === action);
}

// ---------------------------------------------------------------------------
// Tests for each TrayState variant
// ---------------------------------------------------------------------------

describe('buildTrayMenuItems — idle state', () => {
  const state: TrayState = { state: 'idle' };
  const items = buildTrayMenuItems(state);

  it('returns exactly 4 items', () => {
    expect(items).toHaveLength(4);
  });

  it('open-main is present and enabled', () => {
    const item = itemByAction(items, 'open-main');
    expect(item).toBeDefined();
    expect(item!.enabled).toBe(true);
  });

  it('pause-everything label says "Pause Everything" and is enabled', () => {
    const item = itemByAction(items, 'pause-everything');
    expect(item).toBeDefined();
    expect(item!.label).toBe('Pause Everything');
    expect(item!.enabled).toBe(true);
  });

  it('latest-briefing is present and enabled', () => {
    const item = itemByAction(items, 'latest-briefing');
    expect(item).toBeDefined();
    expect(item!.enabled).toBe(true);
  });

  it('quit is present and enabled', () => {
    const item = itemByAction(items, 'quit');
    expect(item).toBeDefined();
    expect(item!.enabled).toBe(true);
  });
});

describe('buildTrayMenuItems — paused state', () => {
  const state: TrayState = { state: 'paused' };
  const items = buildTrayMenuItems(state);

  it('pause-everything label says "Resume Everything" when paused', () => {
    const item = itemByAction(items, 'pause-everything');
    expect(item).toBeDefined();
    expect(item!.label).toBe('Resume Everything');
  });

  it('pause-everything is enabled in paused state', () => {
    const item = itemByAction(items, 'pause-everything');
    expect(item!.enabled).toBe(true);
  });
});

describe('buildTrayMenuItems — scanning state', () => {
  const state: TrayState = { state: 'scanning' };
  const items = buildTrayMenuItems(state);

  it('pause-everything is DISABLED while scanning', () => {
    const item = itemByAction(items, 'pause-everything');
    expect(item).toBeDefined();
    expect(item!.enabled).toBe(false);
  });

  it('open-main remains enabled while scanning', () => {
    const item = itemByAction(items, 'open-main');
    expect(item!.enabled).toBe(true);
  });

  it('quit remains enabled while scanning', () => {
    const item = itemByAction(items, 'quit');
    expect(item!.enabled).toBe(true);
  });
});

describe('buildTrayMenuItems — acting state', () => {
  const state: TrayState = { state: 'acting' };
  const items = buildTrayMenuItems(state);

  it('pause-everything is DISABLED while acting', () => {
    const item = itemByAction(items, 'pause-everything');
    expect(item).toBeDefined();
    expect(item!.enabled).toBe(false);
  });

  it('pause-everything label says "Pause Everything" (not "Resume") while acting', () => {
    const item = itemByAction(items, 'pause-everything');
    expect(item!.label).toBe('Pause Everything');
  });
});

describe('buildTrayMenuItems — item shape', () => {
  it('every item has label, action, and enabled fields', () => {
    const items = buildTrayMenuItems({ state: 'idle' });
    for (const item of items) {
      expect(typeof item.label).toBe('string');
      expect(item.label.length).toBeGreaterThan(0);
      expect(['open-main', 'pause-everything', 'latest-briefing', 'quit']).toContain(
        item.action,
      );
      expect(typeof item.enabled).toBe('boolean');
    }
  });

  it('all four action values are present', () => {
    const items = buildTrayMenuItems({ state: 'idle' });
    const actions = items.map((i) => i.action);
    expect(actions).toContain('open-main');
    expect(actions).toContain('pause-everything');
    expect(actions).toContain('latest-briefing');
    expect(actions).toContain('quit');
  });
});
