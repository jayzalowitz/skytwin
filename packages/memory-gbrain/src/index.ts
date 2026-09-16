/**
 * @skytwin/memory-gbrain
 *
 * Two complementary surfaces:
 *
 *   1. `EmbeddedGbrainMemoryPort` — SkyTwin's gbrain-compatible in-process
 *      implementation against the brain_* CockroachDB tables (or an in-memory
 *      store for tests). This is the production default; it ships with
 *      hash-trick embeddings that work zero-config and an OpenAI-compatible
 *      HTTP provider for production-grade recall. It is not the separately
 *      installed upstream Bun runtime.
 *
 *   2. `GbrainMemoryPort` (CLI variant) — the interoperability adapter for the
 *      real upstream `gbrain` CLI. It translates upstream SearchResult values
 *      into SkyTwin's MemoryPort contract and returns [] when the CLI is absent.
 *      The API backend factory does not select this adapter automatically.
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
