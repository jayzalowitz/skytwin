/**
 * Locale & timezone resolution helpers (#spec 12, #486).
 *
 * The briefing prose locale was hardcoded 'en', users have no language/timezone,
 * and the extraction fallbacks are English-only. These pure helpers centralize
 * the safe-fallback rules and the "is this non-English?" routing signal so the
 * LLM path handles other locales and the English rule fallback marks itself
 * `degraded` instead of silently returning empty.
 */

/** Resolve the effective language, falling back to 'en'. */
export function resolveLanguage(lang?: string | null): string {
  const l = (lang ?? '').trim();
  return l.length > 0 ? l : 'en';
}

/**
 * Resolve the effective timezone. `defaulted` is true when we fell back to UTC
 * (the caller should log a warning — we never silently guess a tz).
 */
export function resolveTimezone(tz?: string | null): { timezone: string; defaulted: boolean } {
  const t = (tz ?? '').trim();
  return t.length > 0 ? { timezone: t, defaulted: false } : { timezone: 'UTC', defaulted: true };
}

/** True when the language is anything other than English. Drives LLM-vs-rule routing. */
export function isNonEnglish(lang?: string | null): boolean {
  const l = resolveLanguage(lang).toLowerCase();
  return !(l === 'en' || l.startsWith('en-') || l.startsWith('en_'));
}
