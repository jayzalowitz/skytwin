/**
 * @skytwin/memory-gbrain
 *
 * Two complementary surfaces:
 *
 *   1. `EmbeddedGbrainMemoryPort` — full in-process implementation against
 *      the brain_* CockroachDB tables (or an in-memory store for tests).
 *      This is the production default; it ships with hash-trick embeddings
 *      that work zero-config and an OpenAI-compatible HTTP provider for
 *      production-grade recall.
 *
 *   2. `GbrainMemoryPort` (CLI variant) — a thin shell-out to the upstream
 *      `gbrain` CLI for users who already run gbrain externally and want to
 *      consume their existing brain. Returns [] when the CLI is absent.
 *
 * The hybrid composer (`@skytwin/memory-hybrid`) routes per-capability between
 * the gbrain backend (semantic + code-aware + graph + episodic) and a
 * mempalace backend (spatial wings + AAAK compression).
 */

export {
  EmbeddedGbrainMemoryPort,
  type EmbeddedGbrainOptions,
  type EmbeddedGbrainBackend,
} from './embedded-port.js';

export { GbrainMemoryPort, NotImplementedError } from './gbrain-port.js';
export { isGbrainInstalled, hasExternalGbrainConfig } from './cli-detector.js';

// Re-export embedding providers as a convenience (so callers can pin a
// provider without importing the adapter package directly).
export {
  HashEmbeddingProvider,
  OpenAiEmbeddingProvider,
  type EmbeddingProvider,
  type OpenAiEmbeddingOptions,
} from '@skytwin/memory-gbrain-crdb-adapter';
