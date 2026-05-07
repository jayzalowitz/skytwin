import { createLogger } from '@skytwin/core';
import { mcpServerMetricsRepository } from '@skytwin/db';
import { MetricsRollupService, sharedMetricsCollector } from '@skytwin/observability';

const log = createLogger('worker:metrics-rollup');

const rollupService = new MetricsRollupService(sharedMetricsCollector, mcpServerMetricsRepository);

export interface MetricsRollupJobDeps {
  /** Inject a different service for testing. */
  service?: MetricsRollupService;
}

/**
 * Drain the in-memory metrics buffer and write 1-minute rollup rows to the DB.
 *
 * Intended to be called by the worker main loop every 60 seconds.
 *
 * Usage in apps/worker/src/index.ts (to be wired when the polling loop
 * supports a separate periodic job cadence):
 *
 *   import { runMetricsRollupJob } from './jobs/metrics-rollup.js';
 *   // Inside the loop, if (elapsed >= 60_000) { await runMetricsRollupJob(); }
 */
export async function runMetricsRollupJob(
  deps: MetricsRollupJobDeps = {},
): Promise<void> {
  const svc = deps.service ?? rollupService;

  try {
    const written = await svc.rollup();
    if (written > 0) {
      log.info(`Metrics rollup: flushed ${written} server bucket(s) to DB`);
    }
  } catch (err) {
    log.warn('Metrics rollup job failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
