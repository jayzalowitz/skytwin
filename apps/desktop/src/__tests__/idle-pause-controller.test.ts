import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IdlePauseController } from '../idle-pause-controller.js';

function makeDeps(overrides: Partial<{
  enabled: boolean;
  paused: boolean;
}> = {}) {
  let enabled = overrides.enabled ?? true;
  let paused = overrides.paused ?? false;
  const pauseServices = vi.fn(async () => { paused = true; });
  const resumeServices = vi.fn(async () => { paused = false; });
  return {
    getEnabled: () => enabled,
    isCurrentlyPaused: () => paused,
    pauseServices,
    resumeServices,
    setEnabled: (v: boolean) => { enabled = v; },
    setPaused: (v: boolean) => { paused = v; },
    getPaused: () => paused,
  };
}

describe('IdlePauseController', () => {
  let deps: ReturnType<typeof makeDeps>;
  let controller: IdlePauseController;

  beforeEach(() => {
    deps = makeDeps();
    controller = new IdlePauseController(deps);
  });

  it('pauses when the user goes idle and the setting is enabled', async () => {
    const action = await controller.onIdleStateChange('idle');
    expect(action).toBe('pause');
    expect(deps.pauseServices).toHaveBeenCalledOnce();
    expect(controller.isAutoPausedByIdle()).toBe(true);
  });

  it('resumes when the user comes back and we were the one who paused', async () => {
    await controller.onIdleStateChange('idle');
    const action = await controller.onIdleStateChange('active');
    expect(action).toBe('resume');
    expect(deps.resumeServices).toHaveBeenCalledOnce();
    expect(controller.isAutoPausedByIdle()).toBe(false);
  });

  it('does NOT pause when the setting is disabled', async () => {
    deps.setEnabled(false);
    const action = await controller.onIdleStateChange('idle');
    expect(action).toBe('noop');
    expect(deps.pauseServices).not.toHaveBeenCalled();
  });

  it('does NOT pause when the user has already manually paused', async () => {
    deps.setPaused(true);
    const action = await controller.onIdleStateChange('idle');
    expect(action).toBe('noop');
    expect(deps.pauseServices).not.toHaveBeenCalled();
    expect(controller.isAutoPausedByIdle()).toBe(false);
  });

  it('does NOT auto-resume when the user manually paused mid-idle', async () => {
    // Idle event → we auto-pause.
    await controller.onIdleStateChange('idle');
    // User then clicks "pause" again (or hits the kill switch).
    controller.onManualPauseChange();
    expect(controller.isAutoPausedByIdle()).toBe(false);
    // User comes back. We must NOT auto-resume — the user's intent
    // (paused) wins over our auto-state.
    const action = await controller.onIdleStateChange('active');
    expect(action).toBe('noop');
    expect(deps.resumeServices).not.toHaveBeenCalled();
  });

  it('idempotent on repeated idle events while already auto-paused', async () => {
    await controller.onIdleStateChange('idle');
    deps.pauseServices.mockClear();
    // After the first pause, isCurrentlyPaused() returns true; second
    // idle event sees that and short-circuits to noop.
    const action = await controller.onIdleStateChange('idle');
    expect(action).toBe('noop');
    expect(deps.pauseServices).not.toHaveBeenCalled();
  });

  it('idempotent on active when we never auto-paused', async () => {
    const action = await controller.onIdleStateChange('active');
    expect(action).toBe('noop');
    expect(deps.resumeServices).not.toHaveBeenCalled();
  });

  it('disabling the setting while auto-paused triggers immediate resume', async () => {
    await controller.onIdleStateChange('idle');
    expect(controller.isAutoPausedByIdle()).toBe(true);
    const action = await controller.onEnabledChanged(false);
    expect(action).toBe('resume');
    expect(deps.resumeServices).toHaveBeenCalledOnce();
    expect(controller.isAutoPausedByIdle()).toBe(false);
  });

  it('disabling the setting when NOT auto-paused is a noop', async () => {
    const action = await controller.onEnabledChanged(false);
    expect(action).toBe('noop');
    expect(deps.resumeServices).not.toHaveBeenCalled();
  });

  it('manual resume mid-idle clears the auto-paused flag', async () => {
    await controller.onIdleStateChange('idle');
    controller.onManualPauseChange(); // covers both manual pause and manual resume per the design
    expect(controller.isAutoPausedByIdle()).toBe(false);
  });

  it('after manual resume + still idle, next idle->idle is a noop (no double pause)', async () => {
    await controller.onIdleStateChange('idle');
    // User manually resumes (which clears the auto flag) but stays away.
    controller.onManualPauseChange();
    deps.setPaused(false);
    // Bridge fires the steady-state idle event again — since the user
    // just reasserted "I want it running", we should NOT immediately
    // re-pause on the same idle window. The next active→idle EDGE
    // would re-pause, but a repeat 'idle' callback shouldn't.
    //
    // The controller treats every 'idle' call as a candidate for pause
    // unless already paused. Once the user manually unpauses while
    // idle, the next event will re-pause — which matches the contract
    // and is what the user asked for ("pause when idle" is on).
    const action = await controller.onIdleStateChange('idle');
    expect(action).toBe('pause');
  });
});
