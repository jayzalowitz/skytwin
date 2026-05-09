/**
 * Model registry (#187 AC#5).
 *
 * Tracks the curated set of embedded LLM models we recommend, indexed by
 * a small set of size buckets that map to RAM brackets. The registry is
 * static — versioned with the package — so no network calls happen at
 * runtime. When the SkyTwin team ships a better model in a given bucket,
 * the registry entry's `version` bumps and clients see a "your twin can
 * be N% smarter" prompt on next launch.
 *
 * Size buckets are coarse on purpose. A user with 8GB RAM doesn't need
 * to choose between 17 model variants — they need one good default.
 *
 * The registry never auto-applies an upgrade. `checkForUpgrade` returns
 * a recommendation; the user has to explicitly accept the download.
 */

export type RamBracket = '4gb' | '8gb' | '16gb' | '32gb-plus';

export interface ModelEntry {
  /** Stable identifier used in DB rows + API responses. */
  id: string;
  /** Human-friendly name shown in UX. */
  displayName: string;
  /** Which RAM bracket this model targets. */
  ramBracket: RamBracket;
  /** Approximate download size in bytes. */
  approxBytes: number;
  /** Approximate context window in tokens. */
  contextWindow: number;
  /** Curated benchmark score (0-100) — relative within the bracket. */
  qualityScore: number;
  /** Where to download this model. The runtime never hits this URL — */
  /** the model downloader (#187 AC#2) does. */
  downloadUrl: string;
  /** SHA-256 of the GGUF, base16. The downloader verifies after fetch. */
  sha256: string;
  /** Registry-internal version — bump when a better quant of the same */
  /** model lands. The displayName stays stable across versions. */
  version: number;
}

/**
 * Curated model list. Hand-maintained.
 *
 * Updating this list:
 *   1. Bump the entry's `version`
 *   2. Update `qualityScore` if it moved measurably
 *   3. Update `sha256` and `downloadUrl` to point at the new artifact
 *   4. Ship a new package release
 *
 * Clients that have an older version will see an upgrade prompt on next
 * `checkForUpgrade()` call.
 */
export const MODEL_REGISTRY: readonly ModelEntry[] = Object.freeze([
  {
    id: 'phi-3.5-mini-q4',
    displayName: 'Phi-3.5 Mini (Q4)',
    ramBracket: '4gb',
    approxBytes: 2.4 * 1024 * 1024 * 1024,
    contextWindow: 4096,
    qualityScore: 72,
    downloadUrl: 'https://huggingface.co/microsoft/Phi-3.5-mini-instruct-gguf/resolve/main/Phi-3.5-mini-instruct-q4.gguf',
    sha256: '0000000000000000000000000000000000000000000000000000000000000000',
    version: 1,
  },
  {
    id: 'qwen-2.5-3b-q4',
    displayName: 'Qwen2.5 3B (Q4)',
    ramBracket: '8gb',
    approxBytes: 2.0 * 1024 * 1024 * 1024,
    contextWindow: 32_768,
    qualityScore: 78,
    downloadUrl: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    sha256: '0000000000000000000000000000000000000000000000000000000000000000',
    version: 1,
  },
  {
    id: 'llama-3.2-3b-q4',
    displayName: 'Llama 3.2 3B (Q4)',
    ramBracket: '8gb',
    approxBytes: 2.0 * 1024 * 1024 * 1024,
    contextWindow: 128_000,
    qualityScore: 80,
    downloadUrl: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    sha256: '0000000000000000000000000000000000000000000000000000000000000000',
    version: 1,
  },
  {
    id: 'qwen-2.5-7b-q4',
    displayName: 'Qwen2.5 7B (Q4)',
    ramBracket: '16gb',
    approxBytes: 4.5 * 1024 * 1024 * 1024,
    contextWindow: 32_768,
    qualityScore: 86,
    downloadUrl: 'https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf',
    sha256: '0000000000000000000000000000000000000000000000000000000000000000',
    version: 1,
  },
  {
    id: 'qwen-2.5-14b-q4',
    displayName: 'Qwen2.5 14B (Q4)',
    ramBracket: '32gb-plus',
    approxBytes: 9 * 1024 * 1024 * 1024,
    contextWindow: 32_768,
    qualityScore: 92,
    downloadUrl: 'https://huggingface.co/Qwen/Qwen2.5-14B-Instruct-GGUF/resolve/main/qwen2.5-14b-instruct-q4_k_m.gguf',
    sha256: '0000000000000000000000000000000000000000000000000000000000000000',
    version: 1,
  },
]);

export function findById(id: string): ModelEntry | null {
  return MODEL_REGISTRY.find((m) => m.id === id) ?? null;
}

export function listByBracket(bracket: RamBracket): ModelEntry[] {
  return MODEL_REGISTRY.filter((m) => m.ramBracket === bracket).slice();
}

export interface UpgradeRecommendation {
  /** Currently-installed model id (may be unknown to the registry). */
  currentId: string;
  /** Upgrade target — same RAM bracket, higher quality. */
  recommended: ModelEntry;
  /** Approximate quality improvement, e.g. "30% smarter". */
  qualityDeltaPct: number;
  /** Why this is the recommended upgrade in plain English. */
  rationale: string;
}

/**
 * Decide whether the user should upgrade. Returns null if the current
 * model is already the best in its bracket, or if the current model is
 * unknown to the registry (don't push upgrades to users who pinned a
 * custom model — they're explicitly off the curated path).
 */
export function checkForUpgrade(
  currentModelId: string,
  registry: readonly ModelEntry[] = MODEL_REGISTRY,
): UpgradeRecommendation | null {
  const current = registry.find((m) => m.id === currentModelId);
  if (!current) return null;

  // Look for a strictly-better model in the same bracket. "Strictly
  // better" = higher qualityScore. We don't recommend cross-bracket
  // upgrades automatically — going from 8GB to 16GB might exceed the
  // user's RAM.
  const candidates = registry.filter(
    (m) => m.ramBracket === current.ramBracket && m.qualityScore > current.qualityScore,
  );
  if (candidates.length === 0) return null;

  const best = candidates.reduce((a, b) => (a.qualityScore > b.qualityScore ? a : b));
  const deltaPct = Math.round(((best.qualityScore - current.qualityScore) / current.qualityScore) * 100);

  return {
    currentId: currentModelId,
    recommended: best,
    qualityDeltaPct: deltaPct,
    rationale: `${best.displayName} scores ${best.qualityScore}/100 on our curated benchmark vs your current ${current.qualityScore}/100. Same RAM bracket (${current.ramBracket}), ~${(best.approxBytes / 1024 / 1024 / 1024).toFixed(1)}GB download.`,
  };
}

/**
 * Recommend a default model for a given system RAM bucket. Used on
 * first run when the user has no model installed yet.
 */
export function recommendDefault(bracket: RamBracket): ModelEntry {
  const candidates = listByBracket(bracket);
  if (candidates.length === 0) {
    // Fallback to the smallest bracket — unusual, but better than a crash.
    return MODEL_REGISTRY[0]!;
  }
  return candidates.reduce((a, b) => (a.qualityScore > b.qualityScore ? a : b));
}
