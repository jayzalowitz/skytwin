/**
 * Launch demo fixture (spec 09, #482) — opt-in, isolated, idempotent.
 *
 * Populates a reserved demo user with a rich, synthetic, source-varied signal
 * set so every digest surface can be exercised and screenshotted. Runs ONLY via
 * this command (never wired into bin/skytwin-dev or any startup path), guards
 * with assertDemoSafe before writing anything, and isolates every write to the
 * demo user (is_demo = true). See demo-guard.ts for invariant #0.
 *
 *   pnpm demo:fixture                 # populate (local dev only)
 *   pnpm demo:fixture --reset         # delete demo data only
 *   pnpm demo:fixture --i-understand-this-writes-demo-data   # allow non-local DB
 */

import { pathToFileURL } from 'node:url';
import { getPool, withTransaction, closePool } from '../connection.js';
import { seedUpsert } from './upsert.js';
import {
  assertDemoSafe,
  REQUIRED_OVERRIDE_TOKEN,
  DEMO_USER_ID,
  type DemoGuardEnv,
} from './demo-guard.js';
import { DEMO_SIGNALS } from './demo-fixtures/signals.js';
import { triggerDemoBriefing } from './demo-briefing.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const reset = argv.includes('--reset');
  const overrideToken = argv.includes(`--${REQUIRED_OVERRIDE_TOKEN}`)
    ? REQUIRED_OVERRIDE_TOKEN
    : undefined;

  // Gate 1+2: explicit (this command IS the opt-in) + environment safety.
  const env: DemoGuardEnv = {
    nodeEnv: process.env.NODE_ENV,
    dbTarget: process.env.DATABASE_URL,
    explicitOptIn: true,
    overrideToken,
  };
  const guard = assertDemoSafe(env);
  if (!guard.ok) {
    console.error(`[demo:fixture] REFUSED — ${guard.reason}`);
    process.exit(1);
    return;
  }

  getPool();

  if (reset) {
    // Gate 3 by predicate: only is_demo rows are touched. Owned rows cascade.
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM users WHERE is_demo = true`);
    });
    console.log('[demo:fixture] reset complete — removed is_demo users only.');
    await closePool();
    return;
  }

  // Upsert the reserved demo user (is_demo = true) + an empty profile.
  await withTransaction(async (client) => {
    await seedUpsert(client, {
      table: 'users',
      row: {
        id: DEMO_USER_ID,
        email: 'demo@local.demo',
        name: 'Demo User',
        trust_tier: 'moderate_autonomy',
        autonomy_settings: JSON.stringify({ maxAutoSpend: 5000 }),
        is_demo: true,
      },
      conflict: ['id'],
      update: 'all',
    });
    await seedUpsert(client, {
      table: 'twin_profiles',
      row: { user_id: DEMO_USER_ID, version: 1 },
      conflict: ['user_id'],
      update: 'nothing',
    });
  });

  // Ingest synthetic signals through the real pipeline (spec's preferred path),
  // so the digest reflects true system output. Requires the local API to be up
  // (./bin/skytwin-dev). Best-effort: log guidance if it isn't.
  const apiUrl = process.env.SKYTWIN_API_URL ?? 'http://localhost:3100';
  let ingested = 0;
  for (const sig of DEMO_SIGNALS) {
    try {
      const res = await fetch(`${apiUrl}/api/events/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: DEMO_USER_ID,
          source: sig.source,
          type: sig.type,
          data: sig.data,
        }),
      });
      if (res.ok) ingested++;
    } catch {
      // API not running — fall through to guidance below.
      break;
    }
  }

  if (ingested === DEMO_SIGNALS.length) {
    // Force a daily briefing for the demo user so the digest is populated
    // immediately (no 24h cron wait). Best-effort: if the worker job can't be
    // loaded/run, fall back to guidance rather than aborting the fixture.
    const briefing = await triggerDemoBriefing({ userId: DEMO_USER_ID });
    const briefingLine = briefing.ok
      ? '  daily briefing generated — /api/twin-briefings/latest is populated.\n'
      : `  briefing not generated (${briefing.reason}).\n` +
        '    Run the worker (./bin/skytwin-dev) and re-run, or wait for its cycle.\n';
    console.log(
      `[demo:fixture] done — demo user provisioned, ${ingested} synthetic signals ingested.\n` +
        briefingLine +
        'Then screenshot:\n' +
        '  • /briefing — to-dos vs topics, source chips, citations\n' +
        '  • dashboard — trust-tier progress, recent activity\n' +
        '  • mobile BriefingScreen',
    );
  } else {
    console.log(
      `[demo:fixture] demo user provisioned; ingested ${ingested}/${DEMO_SIGNALS.length} signals.\n` +
        `Start the local stack (./bin/skytwin-dev) so ${apiUrl}/api/events/ingest is reachable, then re-run.`,
    );
  }

  await closePool();
}

// Entry guard: only run as a CLI (pnpm demo:fixture), never on import. Tests
// import this module to exercise triggerDemoBriefing without running main().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[demo:fixture] failed:', err);
    process.exit(1);
  });
}
