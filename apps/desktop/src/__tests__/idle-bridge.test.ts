import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IdleBridge,
  type IdleStateReason,
  type PowerMonitorLike,
} from '../idle-bridge.js';

interface FakePowerMonitor extends PowerMonitorLike {
  fire(event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume'): void;
  setIdleSeconds(s: number): void;
}

function makeFakePowerMonitor(): FakePowerMonitor {
  let idleSeconds = 0;
  const listeners = new Map<string, Array<() => void>>();
  return {
    getSystemIdleTime: () => idleSeconds,
    on(ev, listener) {
      const arr = listeners.get(ev) ?? [];
      arr.push(listener);
      listeners.set(ev, arr);
    },
    off(ev, listener) {
      const arr = listeners.get(ev) ?? [];
      listeners.set(
        ev,
        arr.filter((l) => l !== listener),
      );
    },
    fire(ev) {
      for (const l of listeners.get(ev) ?? []) l();
    },
    setIdleSeconds(s) {
      idleSeconds = s;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('IdleBridge', () => {
  it('starts in active state', () => {
    const pm = makeFakePowerMonitor();
    const bridge = new IdleBridge({
      onStateChange: () => {},
      powerMonitor: pm,
      logger: { info: () => {} },
    });
    expect(bridge.getState()).toBe('active');
  });

  it('transitions to idle when getSystemIdleTime exceeds threshold', () => {
    const pm = makeFakePowerMonitor();
    const events: Array<[string, IdleStateReason]> = [];
    const bridge = new IdleBridge({
      idleThresholdSeconds: 60,
      pollIntervalMs: 1000,
      onStateChange: (s, r) => events.push([s, r]),
      powerMonitor: pm,
      logger: { info: () => {} },
    });
    bridge.start();

    pm.setIdleSeconds(70);
    vi.advanceTimersByTime(1100);

    expect(bridge.getState()).toBe('idle');
    expect(events).toEqual([['idle', 'idle-threshold']]);
  });

  it('only emits one transition per state change (debounced)', () => {
    const pm = makeFakePowerMonitor();
    const events: Array<[string, IdleStateReason]> = [];
    const bridge = new IdleBridge({
      idleThresholdSeconds: 60,
      pollIntervalMs: 1000,
      onStateChange: (s, r) => events.push([s, r]),
      powerMonitor: pm,
      logger: { info: () => {} },
    });
    bridge.start();

    pm.setIdleSeconds(70);
    vi.advanceTimersByTime(5000);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(['idle', 'idle-threshold']);
  });

  it('transitions back to active when idle time drops below threshold', () => {
    const pm = makeFakePowerMonitor();
    const events: Array<[string, IdleStateReason]> = [];
    const bridge = new IdleBridge({
      idleThresholdSeconds: 60,
      pollIntervalMs: 1000,
      onStateChange: (s, r) => events.push([s, r]),
      powerMonitor: pm,
      logger: { info: () => {} },
    });
    bridge.start();

    pm.setIdleSeconds(70);
    vi.advanceTimersByTime(1100);
    pm.setIdleSeconds(2);
    vi.advanceTimersByTime(1100);

    expect(events).toEqual([
      ['idle', 'idle-threshold'],
      ['active', 'idle-resumed'],
    ]);
    expect(bridge.getState()).toBe('active');
  });

  it('responds to lock-screen → unlock-screen events', () => {
    const pm = makeFakePowerMonitor();
    const events: Array<[string, IdleStateReason]> = [];
    const bridge = new IdleBridge({
      onStateChange: (s, r) => events.push([s, r]),
      powerMonitor: pm,
      logger: { info: () => {} },
    });
    bridge.start();

    pm.fire('lock-screen');
    expect(events).toEqual([['idle', 'lock-screen']]);
    pm.fire('unlock-screen');
    expect(events).toEqual([
      ['idle', 'lock-screen'],
      ['active', 'unlock-screen'],
    ]);
  });

  it('responds to suspend → resume events', () => {
    const pm = makeFakePowerMonitor();
    const events: Array<[string, IdleStateReason]> = [];
    const bridge = new IdleBridge({
      onStateChange: (s, r) => events.push([s, r]),
      powerMonitor: pm,
      logger: { info: () => {} },
    });
    bridge.start();

    pm.fire('suspend');
    pm.fire('resume');

    expect(events).toEqual([
      ['idle', 'suspend'],
      ['active', 'resume'],
    ]);
  });

  it('does not fire duplicate events when same-state signal arrives', () => {
    const pm = makeFakePowerMonitor();
    const events: Array<[string, IdleStateReason]> = [];
    const bridge = new IdleBridge({
      onStateChange: (s, r) => events.push([s, r]),
      powerMonitor: pm,
      logger: { info: () => {} },
    });
    bridge.start();

    pm.fire('lock-screen');
    pm.fire('suspend'); // already idle — no-op

    expect(events).toEqual([['idle', 'lock-screen']]);
  });

  it('isolates handler exceptions — does not throw out of the bridge', () => {
    const pm = makeFakePowerMonitor();
    const bridge = new IdleBridge({
      onStateChange: () => { throw new Error('handler boom'); },
      powerMonitor: pm,
      logger: { info: () => {} },
    });
    bridge.start();
    expect(() => pm.fire('lock-screen')).not.toThrow();
  });

  it('start() is idempotent', () => {
    const pm = makeFakePowerMonitor();
    const onSpy = vi.spyOn(pm, 'on');
    const bridge = new IdleBridge({
      onStateChange: () => {},
      powerMonitor: pm,
      logger: { info: () => {} },
    });
    bridge.start();
    bridge.start();
    expect(onSpy).toHaveBeenCalledTimes(4);
  });

  it('stop() removes listeners and clears timer', () => {
    const pm = makeFakePowerMonitor();
    const offSpy = vi.spyOn(pm, 'off');
    const events: Array<[string, IdleStateReason]> = [];
    const bridge = new IdleBridge({
      onStateChange: (s, r) => events.push([s, r]),
      powerMonitor: pm,
      logger: { info: () => {} },
    });
    bridge.start();
    bridge.stop();

    pm.fire('lock-screen'); // listener was off()'d, should not fire
    pm.setIdleSeconds(99999);
    vi.advanceTimersByTime(60_000); // poll timer should be cleared

    expect(events).toEqual([]);
    expect(offSpy).toHaveBeenCalledTimes(4);
  });

  it('stop() is idempotent', () => {
    const pm = makeFakePowerMonitor();
    const bridge = new IdleBridge({
      onStateChange: () => {},
      powerMonitor: pm,
      logger: { info: () => {} },
    });
    bridge.start();
    bridge.stop();
    expect(() => bridge.stop()).not.toThrow();
  });

  it('runs as no-op when powerMonitor is unavailable', () => {
    const events: Array<unknown> = [];
    const bridge = new IdleBridge({
      onStateChange: (s) => events.push(s),
      powerMonitor: null as never,
      logger: { info: () => {} },
    });
    bridge.start();
    vi.advanceTimersByTime(60_000);
    expect(events).toHaveLength(0);
    bridge.stop();
  });
});
