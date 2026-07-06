import { describe, it, expect, vi } from 'vitest';
import { EventDrivenIdleDetector } from '../idle-detector.js';

describe('EventDrivenIdleDetector', () => {
  it('does not fire before start()', () => {
    const d = new EventDrivenIdleDetector();
    const onIdle = vi.fn();
    d.onIdle(onIdle);
    d.setIdle();
    expect(onIdle).not.toHaveBeenCalled();
    expect(d.isIdle()).toBe(false);
  });

  it('relays idle → active edges once started', () => {
    const d = new EventDrivenIdleDetector();
    const onIdle = vi.fn();
    const onActive = vi.fn();
    d.onIdle(onIdle);
    d.onActive(onActive);
    d.start();

    d.setIdle();
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(d.isIdle()).toBe(true);

    d.setActive();
    expect(onActive).toHaveBeenCalledTimes(1);
    expect(d.isIdle()).toBe(false);
  });

  it('de-dupes repeated same-state signals (clean edges only)', () => {
    const d = new EventDrivenIdleDetector();
    const onIdle = vi.fn();
    const onActive = vi.fn();
    d.onIdle(onIdle);
    d.onActive(onActive);
    d.start();

    d.setIdle();
    d.setIdle();
    d.setIdle();
    expect(onIdle).toHaveBeenCalledTimes(1);

    d.setActive();
    d.setActive();
    expect(onActive).toHaveBeenCalledTimes(1);
  });

  it('setActive is a no-op when already active (never fired idle)', () => {
    const d = new EventDrivenIdleDetector();
    const onActive = vi.fn();
    d.onActive(onActive);
    d.start();
    d.setActive();
    expect(onActive).not.toHaveBeenCalled();
  });

  it('stop() halts further relays', () => {
    const d = new EventDrivenIdleDetector();
    const onIdle = vi.fn();
    d.onIdle(onIdle);
    d.start();
    d.stop();
    d.setIdle();
    expect(onIdle).not.toHaveBeenCalled();
  });
});
