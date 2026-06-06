/**
 * Shared hidden-content predicate (#spec 11, #485).
 *
 * The memory layer already honors user hide/pin (the gbrain CRDB adapter drops
 * pages with `metadata.userOverride === 'hidden'` / a `hidden_at` timestamp from
 * retrieval), but the briefing/digest never consulted it — so hidden content
 * leaked into the digest. This is the ONE definition of "hidden" the digest
 * input selection must route through, so there are not two divergent notions.
 *
 * Pure + testable.
 */

export interface SignalVisibilityMeta {
  /** Per-page/per-sender override set by hide controls (#270). */
  userOverride?: string | null;
  /** Snake/camel timestamp variants set when content is hidden. */
  hidden_at?: unknown;
  hiddenAt?: unknown;
}

/** True when the user has hidden this content. Null/undefined meta → not hidden. */
export function isHidden(meta: SignalVisibilityMeta | null | undefined): boolean {
  if (!meta) return false;
  if (meta.userOverride === 'hidden') return true;
  if (meta.hidden_at != null || meta.hiddenAt != null) return true;
  return false;
}

/** Drop items the user has hidden, per `getMeta`. Preserves order. */
export function filterVisible<T>(
  items: T[],
  getMeta: (item: T) => SignalVisibilityMeta | null | undefined,
): T[] {
  return items.filter((item) => !isHidden(getMeta(item)));
}
