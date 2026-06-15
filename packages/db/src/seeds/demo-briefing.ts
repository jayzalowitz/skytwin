/**
 * Demo-fixture briefing trigger (#482).
 *
 * After the demo fixture ingests its synthetic signals, it forces a daily
 * briefing for the demo user so `/api/twin-briefings/latest` returns a
 * populated digest immediately — instead of waiting for the worker's 24h cron
 * (#482 implementation detail #7 / AC#1).
 *
 * Kept in its own module (no DB imports) so the pure wiring is unit-testable
 * without `pg`/a live database, and so `demo-fixture.ts` can stay the thin CLI
 * orchestrator.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

/** Result of attempting to force a demo briefing. Best-effort — never throws. */
export type DemoBriefingResult = { ok: true } | { ok: false; reason: string };

/**
 * The shape of the worker's briefing job, narrowed to what the demo fixture
 * needs. Declared locally (not imported) so `@skytwin/db` keeps a clean
 * dependency graph — apps depend on packages, never the reverse.
 */
export type RunBriefing = (deps: {
  cadence: 'daily' | 'weekly';
  userIds: string[];
}) => Promise<void>;

/**
 * Default briefing runner: resolves `apps/worker/src/jobs/briefing-generator.ts`
 * at RUNTIME via a computed file URL and calls `runBriefingGeneratorJob`.
 *
 * Why a dynamic import rather than a static one: the worker job lives in an
 * app, and `@skytwin/db` (this package) must not statically depend on an app
 * — that would invert the monorepo dependency arrow (apps → packages) and
 * break the build graph + tsc rootDir. The specifier is computed at runtime
 * so tsc never resolves it; turbo's graph (driven by package.json) is
 * untouched. The demo fixture is a dev-only `tsx` CLI, never bundled into the
 * library `dist` other packages consume, so reaching "up" to the worker here
 * is safe and intentional. The briefing job itself only depends on packages
 * (@skytwin/{db,policy-prompts,llm-client,core}), so it loads fine in-process.
 */
async function defaultRunBriefing(deps: {
  cadence: 'daily' | 'weekly';
  userIds: string[];
}): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/db/src/seeds → repo root is four levels up.
  const jobPath = resolve(here, '../../../../apps/worker/src/jobs/briefing-generator.ts');
  const mod = (await import(pathToFileURL(jobPath).href)) as {
    runBriefingGeneratorJob: RunBriefing;
  };
  await mod.runBriefingGeneratorJob(deps);
}

/**
 * Force a daily briefing for the demo user so `/api/twin-briefings/latest`
 * returns a populated digest immediately after ingest (#482 AC#1 / detail #7).
 *
 * Best-effort by design: a missing/failed worker job degrades to a typed
 * `ok:false` result with the reason, never an exception that aborts the
 * fixture after it has already ingested signals. `runBriefing` is injectable
 * so the wiring can be unit-tested without spinning up the worker or a DB.
 */
export async function triggerDemoBriefing(opts: {
  userId: string;
  runBriefing?: RunBriefing;
}): Promise<DemoBriefingResult> {
  const run = opts.runBriefing ?? defaultRunBriefing;
  try {
    await run({ cadence: 'daily', userIds: [opts.userId] });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
