/**
 * Accessibility preferences (#194 Child 4).
 *
 * Three knobs persisted to localStorage:
 *   - textScale: '100' | '125' | '150' | '200'   (sets data-text-scale on <html>)
 *   - reducedMotion: 'auto' | 'on' | 'off'        (overrides prefers-reduced-motion)
 *   - voiceFirst: 'on' | 'off'                    (enables voice mic affordances)
 *
 * Applied on page load via initA11y() so there's no flash of base styling.
 */

const KEY_TEXT_SCALE = 'skytwin.a11y.text-scale';
const KEY_REDUCED_MOTION = 'skytwin.a11y.reduced-motion';
const KEY_VOICE_FIRST = 'skytwin.a11y.voice-first';

export const A11Y_TEXT_SCALES = ['100', '125', '150', '200'];
export const A11Y_REDUCED_MOTION = ['auto', 'on', 'off'];

export function getTextScale() {
  const v = localStorage.getItem(KEY_TEXT_SCALE);
  return A11Y_TEXT_SCALES.includes(v) ? v : '100';
}

export function setTextScale(value) {
  if (!A11Y_TEXT_SCALES.includes(value)) return;
  localStorage.setItem(KEY_TEXT_SCALE, value);
  applyTextScale(value);
}

function applyTextScale(value) {
  const html = document.documentElement;
  if (value === '100') html.removeAttribute('data-text-scale');
  else html.setAttribute('data-text-scale', value);
}

export function getReducedMotion() {
  const v = localStorage.getItem(KEY_REDUCED_MOTION);
  return A11Y_REDUCED_MOTION.includes(v) ? v : 'auto';
}

export function setReducedMotion(value) {
  if (!A11Y_REDUCED_MOTION.includes(value)) return;
  localStorage.setItem(KEY_REDUCED_MOTION, value);
  applyReducedMotion(value);
}

function applyReducedMotion(value) {
  const html = document.documentElement;
  if (value === 'on') html.setAttribute('data-force-reduced-motion', 'on');
  else if (value === 'off') html.setAttribute('data-force-reduced-motion', 'off');
  else html.removeAttribute('data-force-reduced-motion');
}

export function isVoiceFirstEnabled() {
  return localStorage.getItem(KEY_VOICE_FIRST) === 'on';
}

export function setVoiceFirst(enabled) {
  localStorage.setItem(KEY_VOICE_FIRST, enabled ? 'on' : 'off');
  // Toggle a body class so CSS can show / hide voice-only affordances.
  document.body.classList.toggle('voice-first', !!enabled);
}

/**
 * Apply saved a11y preferences immediately. Call before first render so
 * the user doesn't see a flash of base text size or motion.
 */
export function initA11y() {
  applyTextScale(getTextScale());
  applyReducedMotion(getReducedMotion());
  if (isVoiceFirstEnabled()) document.body.classList.add('voice-first');
}
