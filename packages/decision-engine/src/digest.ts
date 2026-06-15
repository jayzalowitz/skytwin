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
}

export interface BuildDigestOptions {
  knownDomains?: string[];
  maxTodos?: number;
  maxClusters?: number;
}

const URGENCY_RANK: Record<NonNullable<DigestItem['urgency']>, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

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
  const topics: DigestTopic[] = clusters.map((c) => ({
    domain: c.domain,
    title: c.title,
    items: sortPinnedFirst(c.signalRefs, (ref) => byRef.get(ref)?.meta ?? null).map((ref) => {
      const it = byRef.get(ref);
      return { ref, text: it?.text ?? '', body: it?.body, sourceType: it?.sourceType, signalRefs: [ref] };
    }),
  }));

  return { todos, topics };
}
