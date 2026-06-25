/**
 * Digest assembly: split to-dos (act) from topics (be-aware) (#spec 01, #474).
 *
 * The reference AI-inbox product opens with a short "suggested to-dos" list
 * above grouped "topics to catch up on". This composes that structured payload:
 *   - to-dos  = items the decision pipeline flagged action-required, urgency-
 *               ordered and capped.
 *   - topics  = everything else, grouped into life-domain clusters (spec 04).
 *
 * Also the integration point for two earlier specs:
 *   - spec 11: hidden content is filtered out FIRST (the digest must honor the
 *              user's hide choices — closes that wiring).
 *   - spec 07: sourceType travels per item so the UI (spec 08) can show source
 *              chips.
 *
 * Pure + testable. The caller supplies items already tagged with actionRequired
 * (derived from the decision outcome) + domain; deriving those is the briefing
 * generator's job (spec 01 step 0).
 */

import { clusterSignals } from './topic-clusterer.js';
import {
  filterVisible,
  isPinned,
  sortPinnedFirst,
  type SignalVisibilityMeta,
} from './visibility-filter.js';
import type { DigestItemDetail } from './digest-detail.js';
import type { SourceCoverage } from './source-coverage.js';
import type { ResolvedEntity } from './entity-linking.js';
import type { DailyMemorySuggestion } from '@skytwin/shared-types';

export interface DigestItem {
  ref: string;
  text: string;
  /** One-line preview of what the signal actually says (snippet / body). */
  body?: string;
  /** True when the decision pipeline escalated this to the user (a to-do). */
  actionRequired: boolean;
  domain: string | null;
  sourceType?: string;
  deadline?: string | null;
  urgency?: 'low' | 'medium' | 'high' | 'critical';
  /** Visibility metadata (spec 11) — hidden items are dropped. */
  meta?: SignalVisibilityMeta | null;
}

export interface DigestTodo {
  ref: string;
  text: string;
  /** One-line preview of what the signal actually says (snippet / body). */
  body?: string;
  sourceType?: string;
  deadline?: string | null;
  /** Citation refs for the UI chips (review #4: UI + v2 prompt expect signalRefs[]). */
  signalRefs: string[];
  /** Power-view technical depth (spec 14); the generator builds it via buildDigestItemDetail. */
  detail?: DigestItemDetail;
}

export interface DigestTopicItem {
  ref: string;
  text: string;
  /** One-line preview of what the signal actually says (snippet / body). */
  body?: string;
  sourceType?: string;
  signalRefs: string[];
  detail?: DigestItemDetail;
}

export interface DigestTopic {
  domain: string;
  title: string;
  items: DigestTopicItem[];
}

export interface Digest {
  todos: DigestTodo[];
  topics: DigestTopic[];
  /** Source coverage for the power-view panel (spec 13/14). Optional. */
  coverage?: SourceCoverage;
  /** Novel daily suggestions inferred by connecting fresh memory to older context. */
  memorySuggestions?: DailyMemorySuggestion[];
}

export interface BuildDigestOptions {
  knownDomains?: string[];
  maxTodos?: number;
  maxClusters?: number;
  /**
   * Resolved cross-signal entities (spec 05, #478). When supplied, FYI topic
   * items that share a primary entity are collapsed into ONE topic item with
   * the other mentions attached as additional citations (`signalRefs[]`),
   * instead of repeating the same matter across multiple domain clusters.
   * Omit (or pass `[]`) to keep the un-collapsed spec-04 behavior — the
   * `ENTITY_LINKING=off` rollback path passes nothing here.
   */
  entityLinks?: ResolvedEntity[];
}

const URGENCY_RANK: Record<NonNullable<DigestItem['urgency']>, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Build a `signalRef -> primary entityId` map from resolved entities so the
 * digest can collapse signals that share one matter. A signal's PRIMARY entity
 * is the entity (touching >= 2 signals) with the most citations that the signal
 * is linked to — ties broken by `entityId` for determinism. Only multi-signal
 * entities are considered: a singleton entity can never cause a collapse, so it
 * is never a "primary" for collapse purposes. People rank ahead of orgs at an
 * equal citation count — a person key (email) is a strong, exact match, while
 * an org key is fuzzy and the issue treats a false org merge as the worst case.
 */
function primaryEntityByRef(entities: ResolvedEntity[]): Map<string, string> {
  // Candidate entities: only those linking 2+ distinct signals can collapse.
  const linking = entities.filter((e) => new Set(e.signalRefs).size >= 2);

  // Rank: more citations first; person before org on a tie; entityId last for
  // a total, deterministic order.
  const kindRank = (kind: ResolvedEntity['kind']): number => (kind === 'person' ? 0 : 1);
  const ranked = [...linking].sort((a, b) => {
    const byCount = new Set(b.signalRefs).size - new Set(a.signalRefs).size;
    if (byCount !== 0) return byCount;
    const byKind = kindRank(a.kind) - kindRank(b.kind);
    if (byKind !== 0) return byKind;
    return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
  });

  const byRef = new Map<string, string>();
  for (const e of ranked) {
    for (const ref of e.signalRefs) {
      // First (highest-ranked) entity to claim a ref wins it as the primary.
      if (!byRef.has(ref)) byRef.set(ref, e.entityId);
    }
  }
  return byRef;
}

/**
 * Partition digest items into the to-do and topic buckets. Hidden items are
 * dropped first (spec 11/#485); pinned items (#270) are surfaced ahead of
 * unpinned ones of the same kind. To-dos are urgency-ordered and capped; topics
 * are domain clusters (spec 04). No item appears in both buckets.
 */
export function buildDigest(items: DigestItem[], opts: BuildDigestOptions = {}): Digest {
  const maxTodos = opts.maxTodos ?? 7;

  // spec 11 / #485: never surface content the user hid.
  const visible = filterVisible(items, (i) => i.meta ?? null);

  // To-dos: action-required. Pinned items (#270) lead, then urgency order. The
  // capped slice runs AFTER pinned-first ordering so a pin can rescue an item
  // from being truncated off the end of a long to-do list.
  const todos: DigestTodo[] = visible
    .filter((i) => i.actionRequired)
    // Pinned-first is the primary key; urgency is the tiebreaker within each
    // group. Array.prototype.sort is stable in every supported runtime, so
    // equal-key items keep their input order.
    .sort((a, b) => {
      const pinDelta = Number(isPinned(b.meta ?? null)) - Number(isPinned(a.meta ?? null));
      if (pinDelta !== 0) return pinDelta;
      return URGENCY_RANK[a.urgency ?? 'low'] - URGENCY_RANK[b.urgency ?? 'low'];
    })
    .slice(0, maxTodos)
    .map((i) => ({
      ref: i.ref,
      text: i.text,
      body: i.body,
      sourceType: i.sourceType,
      deadline: i.deadline ?? null,
      signalRefs: [i.ref],
    }));

  // Topics: everything else, clustered by domain. Pinned FYI items lead within
  // their cluster so a pinned-but-routine item isn't buried.
  const fyi = visible.filter((i) => !i.actionRequired);
  const byRef = new Map(fyi.map((i) => [i.ref, i]));
  const clusters = clusterSignals(
    fyi.map((i) => ({ ref: i.ref, domain: i.domain, subject: i.text })),
    { knownDomains: opts.knownDomains, maxClusters: opts.maxClusters },
  );
  // Entity collapse (spec 05, #478 AC5): a matter (a single primary entity)
  // spanning multiple FYI signals — possibly across DIFFERENT clusters —
  // renders ONCE with every mention as a citation, not repeated per cluster.
  // The first occurrence (clusters are confidence-ordered) is the canonical
  // line; later mentions fold their refs into it. EXCEPTION (#485): a PINNED
  // item is never collapsed away — the user pinned that signal, so it always
  // stands on its own line.
  const primaryByRef = primaryEntityByRef(opts.entityLinks ?? []);
  // entityId -> the canonical topic item that owns this matter. A later
  // mention (in this or any subsequent cluster) attaches to it as a citation.
  const canonicalItemForEntity = new Map<string, DigestTopicItem>();

  const topics: DigestTopic[] = [];
  for (const c of clusters) {
    const clusterItems: DigestTopicItem[] = [];
    // Pinned FYI items lead within their cluster (#485) — iterate pinned-first
    // so a pinned-but-routine item isn't buried, and (being first) it becomes
    // the canonical owner of its matter rather than being folded into another.
    for (const ref of sortPinnedFirst(c.signalRefs, (r) => byRef.get(r)?.meta ?? null)) {
      const it = byRef.get(ref);
      const pinned = isPinned(it?.meta ?? null);
      const entityId = primaryByRef.get(ref);
      // A pinned signal is never collapsed into another matter's line; it
      // always renders. (It can still OWN a matter — later non-pinned mentions
      // fold into it — because pinned items are iterated first above.)
      if (entityId !== undefined && !pinned) {
        const canonical = canonicalItemForEntity.get(entityId);
        if (canonical) {
          // This matter already has a canonical line (possibly in an earlier
          // cluster). Attach this signal as a citation (de-duped) and skip it.
          if (!canonical.signalRefs.includes(ref)) canonical.signalRefs.push(ref);
          continue;
        }
      }
      const item: DigestTopicItem = {
        ref,
        text: it?.text ?? '',
        body: it?.body,
        sourceType: it?.sourceType,
        signalRefs: [ref],
      };
      if (entityId !== undefined) canonicalItemForEntity.set(entityId, item);
      clusterItems.push(item);
    }
    // A cluster can end up empty if every one of its signals collapsed into a
    // canonical line living in an earlier cluster. Drop the empty husk.
    if (clusterItems.length > 0) topics.push({ domain: c.domain, title: c.title, items: clusterItems });
  }

  return { todos, topics };
}
