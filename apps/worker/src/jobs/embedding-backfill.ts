import { createLogger } from '@skytwin/core';
import {
  HashEmbeddingProvider,
  OpenAiEmbeddingProvider,
  type EmbeddingProvider,
  leaseEmbeddingJob,
  markJobDone,
  markJobFailed,
  updatePageEmbedding,
  pendingEmbeddingJobs,
} from '@skytwin/memory-gbrain-crdb-adapter';

const log = createLogger('embedding-backfill');

/**
 * Drains the brain_embedding_jobs queue. Each call:
 *   1. Reads batch size pending jobs (default 25) via SELECT FOR UPDATE SKIP LOCKED.
 *   2. Embeds the page content with the configured provider.
 *   3. Writes the embedding back to brain_pages.
 *   4. Marks the job completed (or failed → retried up to 3 times).
 *
 * Why this exists: when a real embedding provider (OpenAI, Ollama) is
 * configured, the synchronous embed call inside `recordSignal` can fail
 * (rate limit, network, timeout). The write path persists the page
 * unembedded and queues a job. This worker drains the queue on a regular
 * schedule so search recall doesn't degrade silently.
 *
 * The default schedule is every 30s. With OpenAI text-embedding-3-small at
 * 5k tokens/sec the worker can drain ~50 embeddings per cycle without
 * sustained backpressure, so the queue empties faster than user activity
 * fills it for any normal twin.
 */
export interface EmbeddingBackfillOptions {
  /** Maximum number of jobs to process per run. Default 25. */
  batchSize?: number;
  /** Override the embedding provider; defaults to the env-driven one. */
  embedding?: EmbeddingProvider;
}

/**
 * Build the default embedding provider for the worker. Mirrors the API's
 * choice in `apps/api/src/memory-setup.ts:getEmbeddingProvider` so the same
 * embeddings are produced on both sides — otherwise async-backfilled rows
 * would be embedded with a different model than synchronous-write rows and
 * cosine similarity across them collapses.
 */
let cached: EmbeddingProvider | null = null;
export function getWorkerEmbeddingProvider(): EmbeddingProvider {
  if (cached) return cached;
  const apiKey = process.env['OPENAI_EMBEDDING_API_KEY'] ?? process.env['OPENAI_API_KEY'];
  if (apiKey) {
    const baseUrl = process.env['OPENAI_EMBEDDING_BASE_URL'];
    const model = process.env['OPENAI_EMBEDDING_MODEL'] ?? 'text-embedding-3-small';
    cached = new OpenAiEmbeddingProvider({
      apiKey,
      model,
      ...(baseUrl ? { baseUrl } : {}),
    });
    log.info('worker embedding provider: openai-compatible', { model });
    return cached;
  }
  cached = new HashEmbeddingProvider();
  log.info('worker embedding provider: hash-fnv1a-v1 (no API key set)');
  return cached;
}

/**
 * Reset the cached provider — used by tests that mutate env vars.
 */
export function _resetEmbeddingProviderCacheForTests(): void {
  cached = null;
}

export interface EmbeddingBackfillSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  pendingAfter: number;
}

/**
 * Run a single backfill pass. Returns a summary so the worker loop can log
 * counters and the test suite can assert correctness.
 */
export async function runEmbeddingBackfillJob(
  opts: EmbeddingBackfillOptions = {},
): Promise<EmbeddingBackfillSummary> {
  const batchSize = opts.batchSize ?? 25;
  const provider = opts.embedding ?? getWorkerEmbeddingProvider();

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < batchSize; i++) {
    const job = await leaseEmbeddingJob().catch((err) => {
      log.warn('leaseEmbeddingJob failed; skipping cycle', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    if (!job) break;
    attempted++;

    try {
      const embedding = await provider.embed(job.pageContent);
      await updatePageEmbedding(job.pageId, embedding, provider.model);
      await markJobDone(job.id);
      succeeded++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      log.warn('embedding job failed; will retry until attempts exhausted', {
        jobId: job.id,
        error: message,
      });
      await markJobFailed(job.id, message).catch((markErr) => {
        log.error('markJobFailed itself failed', {
          jobId: job.id,
          error: markErr instanceof Error ? markErr.message : String(markErr),
        });
      });
    }
  }

  const pendingAfter = await pendingEmbeddingJobs().catch(() => 0);

  if (attempted > 0) {
    log.info('embedding backfill cycle complete', {
      attempted,
      succeeded,
      failed,
      pendingAfter,
    });
  }

  return { attempted, succeeded, failed, pendingAfter };
}
