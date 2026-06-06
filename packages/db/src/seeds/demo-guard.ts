/**
 * Demo-fixture safety guard (#spec 09, #482) — invariant #0.
 *
 * The launch demo fixture must NEVER run for a real or new user. This is the
 * three-gate guard that runs BEFORE the fixture writes anything. All three must
 * pass:
 *   1. Explicit request   — the command/env was deliberately invoked.
 *   2. Environment safety  — never production; non-local DB needs a loud override
 *                            (and even then production stays hard-blocked).
 *   3. Identity isolation  — only ever writes under reserved demo identities
 *                            (asserted per-user at write time via assertDemoUser).
 *
 * Pure + exhaustively tested so the gates can't silently regress.
 */

export interface DemoGuardEnv {
  /** NODE_ENV. */
  nodeEnv: string | undefined;
  /** DB connection target (host or URL); empty/undefined treated as local. */
  dbTarget: string | undefined;
  /** True only when the demo command / SKYTWIN_DEMO_FIXTURE=1 was deliberately set. */
  explicitOptIn: boolean;
  /** The loud override token, required to run against a non-local DB. */
  overrideToken?: string | undefined;
}

export type DemoGuardResult = { ok: true } | { ok: false; reason: string };

/** The exact token a caller must pass to run against a non-local DB. */
export const REQUIRED_OVERRIDE_TOKEN = 'i-understand-this-writes-demo-data';

/** Reserved demo user id (matches the seed demo user). */
export const DEMO_USER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

/** Local DB targets the fixture may run against without an override. */
export function isLocalDbTarget(target: string | undefined): boolean {
  const t = (target ?? '').trim().toLowerCase();
  if (t === '') return true; // unset → local dev default
  return (
    t.includes('localhost') ||
    t.includes('127.0.0.1') ||
    t.includes('::1') ||
    t.includes('@localhost') ||
    t.startsWith('postgresql://localhost') ||
    t.startsWith('postgres://localhost')
  );
}

/**
 * The three-gate safety check. Returns ok:false with a reason rather than
 * throwing, so the caller can print a clear message and exit non-zero.
 */
export function assertDemoSafe(env: DemoGuardEnv): DemoGuardResult {
  // Gate 1 — explicit request.
  if (!env.explicitOptIn) {
    return { ok: false, reason: 'not explicitly requested (run `pnpm demo:fixture` or set SKYTWIN_DEMO_FIXTURE=1)' };
  }
  // Gate 2 — environment safety. Production is hard-blocked: NO override unblocks it.
  if ((env.nodeEnv ?? '').toLowerCase() === 'production') {
    return { ok: false, reason: 'refuses to run in production (no override)' };
  }
  if (!isLocalDbTarget(env.dbTarget)) {
    if (env.overrideToken !== REQUIRED_OVERRIDE_TOKEN) {
      return {
        ok: false,
        reason: `non-local DB target requires --i-understand-this-writes-demo-data (token "${REQUIRED_OVERRIDE_TOKEN}")`,
      };
    }
  }
  return { ok: true };
}

/**
 * Gate 3 (per-write): refuse to touch any user that is not demo-namespaced.
 * Throws — the fixture must abort rather than write to a real user.
 */
export function assertDemoUser(userId: string, isDemo: boolean): void {
  if (!isDemo) {
    throw new Error(
      `demo fixture refused to write to non-demo user ${userId} (is_demo=false). ` +
        'Identity isolation (spec 09 invariant #0).',
    );
  }
}
