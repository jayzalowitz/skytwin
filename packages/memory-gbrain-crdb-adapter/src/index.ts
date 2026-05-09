/**
 * @skytwin/memory-gbrain-crdb-adapter
 *
 * CockroachDB-native backing store for the gbrain memory backend. Provides:
 *   - The brain_* table accessors (`repository.ts`)
 *   - An in-memory fallback for unit tests (`InMemoryBrainStore`)
 *   - The Reciprocal Rank Fusion fold (`rrfFold`)
 *   - Embedding providers (hash-trick fallback + OpenAI-compatible HTTP)
 *
 * Used by `@skytwin/memory-gbrain` to satisfy the `MemoryPort` contract.
 */

export type {
  BrainPageRow,
  BrainEntityRow,
  BrainTripleRow,
  BrainEpisodeRow,
  BrainSignalRow,
  BrainSettingsRow,
  RrfHit,
  InsertBrainPageInput,
} from './types.js';

export {
  HashEmbeddingProvider,
  OpenAiEmbeddingProvider,
  cosineSimilarity,
  tokenise,
  fnv1a32,
} from './embedding.js';
export type { EmbeddingProvider, OpenAiEmbeddingOptions } from './embedding.js';

export { rrfFold } from './rrf.js';

export { InMemoryBrainStore } from './in-memory-repository.js';

// CRDB-backed repository is exported function-by-function so callers don't
// need to instantiate a class. The pg pool is global (singleton from
// @skytwin/db's `getPool`), so module-scope functions are the right shape.
export {
  insertPage,
  updatePageEmbedding,
  hybridSearch,
  textSearch,
  vectorSearch,
  upsertEntity,
  getEntities,
  insertTriple,
  getTriples,
  insertEpisode,
  getEpisodes,
  insertSignal,
  getAllSignals,
  getSettings,
  upsertSettings,
  enqueueEmbeddingJob,
  leaseEmbeddingJob,
  markJobDone,
  markJobFailed,
  pendingEmbeddingJobs,
  getAllPages,
  countPages,
} from './repository.js';
export type { HybridSearchOptions } from './repository.js';
