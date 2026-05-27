import { describe, it, expect } from 'vitest';
import {
  createFirstCloseToastState,
  shouldShowFirstCloseToast,
} from '../first-close-toast.js';

describe('shouldShowFirstCloseToast', () => {
  it('returns true on the first call and flips the state', () => {
    const state = createFirstCloseToastState();
    expect(state.shown).toBe(false);
    expect(shouldShowFirstCloseToast(state)).toBe(true);
    expect(state.shown).toBe(true);
  });

  it('returns false on every subsequent call within the same session', () => {
    const state = createFirstCloseToastState();
    shouldShowFirstCloseToast(state);
    expect(shouldShowFirstCloseToast(state)).toBe(false);
    expect(shouldShowFirstCloseToast(state)).toBe(false);
    expect(shouldShowFirstCloseToast(state)).toBe(false);
  });

  it('treats a fresh state as a fresh session (cross-session reset)', () => {
    // Two distinct state objects model two distinct app launches.
    // Both should fire on their first close so a user who quits and
    // relaunches still sees the explanation if they forgot it.
    const sessionOne = createFirstCloseToastState();
    const sessionTwo = createFirstCloseToastState();
    expect(shouldShowFirstCloseToast(sessionOne)).toBe(true);
    expect(shouldShowFirstCloseToast(sessionTwo)).toBe(true);
  });
});
