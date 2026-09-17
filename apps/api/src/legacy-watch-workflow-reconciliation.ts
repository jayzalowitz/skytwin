import { legacyWatchWorkflowReconciliationRepository } from '@skytwin/db';

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 25;

export interface LegacyWatchWorkflowReconciliationLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface StartLegacyWatchWorkflowReconciliationInput {
  logger: LegacyWatchWorkflowReconciliationLogger;
  intervalMs?: number;
  batchSize?: number;
  reconcileBatch?: typeof legacyWatchWorkflowReconciliationRepository.reconcileBatch;
}

/**
 * Start a non-blocking, single-flight reconciler after database readiness.
 * Each tick performs at most one bounded batch and the unref'd timer never
 * delays process shutdown. Keeping it periodic also catches legacy API writes
 * during a rolling upgrade rather than assuming startup is the only producer.
 */
export function startLegacyWatchWorkflowReconciliation(
  input: StartLegacyWatchWorkflowReconciliationInput,
): () => void {
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new TypeError('Legacy Watch reconciliation interval must be a positive integer');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new TypeError('Legacy Watch reconciliation batch size must be an integer from 1 to 100');
  }
  const reconcile = input.reconcileBatch
    ?? legacyWatchWorkflowReconciliationRepository.reconcileBatch.bind(
      legacyWatchWorkflowReconciliationRepository,
    );
  let stopped = false;
  let running = false;
  const drainTimers = new Set<ReturnType<typeof setTimeout>>();

  const run = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    let shouldDrain = false;
    try {
      const result = await reconcile({ limit: batchSize });
      shouldDrain = result.mayHaveMore;
      const processed = result.legacyWatchesMigrated
        + result.activeWorkflowProjectionsMaterialized;
      if (processed > 0) {
        input.logger.info('Adaptive workflow reconciliation batch completed', { ...result });
      }
    } catch (error) {
      input.logger.warn('Adaptive workflow reconciliation batch failed; a later tick will retry', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
      if (!stopped && shouldDrain) {
        const drainTimer = setTimeout(() => {
          drainTimers.delete(drainTimer);
          void run();
        }, 0);
        drainTimer.unref();
        drainTimers.add(drainTimer);
      }
    }
  };

  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref();
  void run();
  return () => {
    stopped = true;
    clearInterval(timer);
    for (const drainTimer of drainTimers) clearTimeout(drainTimer);
    drainTimers.clear();
  };
}
