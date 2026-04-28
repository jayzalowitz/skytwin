/**
 * Startup-time invariants the api must satisfy *before* it accepts traffic.
 *
 * Kept as pure functions so failures are testable without booting the
 * server. The actual `process.exit(1)` path lives in `index.ts` so a
 * misbehaving caller (or test) can validate without killing the runner.
 */

export interface StartupAssertionResult {
  ok: boolean;
  fatal: boolean;
  message?: string;
}

/**
 * Reasons a SESSION_SECRET is unacceptable in non-dev:
 *   - unset (would silently fall back to the literal default)
 *   - matches the hardcoded dev default (open-source code reveals it)
 *   - too short to provide meaningful HMAC entropy
 *
 * Returns `ok: true` with no message when the env is fine, or
 * `ok: false` with a fatal error message when the api must refuse to start.
 */
export function assertSessionSecret(env: {
  nodeEnv?: string;
  sessionSecret?: string;
  defaultDevSecret?: string;
  minLength?: number;
}): StartupAssertionResult {
  const nodeEnv = env.nodeEnv ?? 'development';
  const secret = env.sessionSecret;
  const defaultDevSecret = env.defaultDevSecret ?? 'skytwin-dev-secret';
  const minLength = env.minLength ?? 32;

  // Dev/test allowed to fall back to the literal default. Everything else
  // must set a real secret.
  if (nodeEnv === 'development' || nodeEnv === 'test') {
    return { ok: true, fatal: false };
  }

  if (!secret) {
    return {
      ok: false,
      fatal: true,
      message:
        `SESSION_SECRET must be set in ${nodeEnv}. ` +
        `Generate one with: openssl rand -hex 32`,
    };
  }

  if (secret === defaultDevSecret) {
    return {
      ok: false,
      fatal: true,
      message:
        `SESSION_SECRET is set to the hardcoded dev default in ${nodeEnv} — ` +
        `this is the literal string anyone reading the open-source code knows. ` +
        `Generate a real secret: openssl rand -hex 32`,
    };
  }

  if (secret.length < minLength) {
    return {
      ok: false,
      fatal: true,
      message:
        `SESSION_SECRET is too short (${secret.length} chars, minimum ${minLength}). ` +
        `Use \`openssl rand -hex 32\`.`,
    };
  }

  return { ok: true, fatal: false };
}
