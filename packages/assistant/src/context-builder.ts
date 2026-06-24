/**
 * Context enrichment for the assistant — issue #147 (phase 2b).
 *
 * Phase 1 (#139) shipped a generic system prompt. The assistant had no idea
 * who the user was, what their preferences were, or what the twin had
 * learned about them — so "what did I tell you about X last month?" and
 * "what's my preference for Y?" — the two killer use cases that distinguish
 * a personal twin from generic ChatGPT — fell through.
 *
 * This module composes a small context section that gets prepended to the
 * system prompt. It pulls from two sources via ports (so this package stays
 * free of `@skytwin/db` and `@skytwin/mempalace` deps and unit-tests
 * cleanly with stubs):
 *
 *   - `TwinContextProvider` — the user's profile (preferences + inferences)
 *   - `MemoryContextProvider` — episodic memories relevant to the question
 *
 * The rendered context is hard-capped at `MAX_CONTEXT_BYTES`. A noisy
 * profile or a long memory hit list cannot dominate the model's token
 * budget — the rest of the prompt (system instructions + conversation
 * history) needs room.
 */

/**
 * Public shape returned by the twin context port. Snake-cased fields are
 * stringified `value: unknown`s — the renderer doesn't care about types,
 * just about producing a compact line.
 */
export interface TwinPreference {
  domain: string;
  key: string;
  value: unknown;
  /** ConfidenceLevel string — 'speculative' | 'low' | 'moderate' | 'high' | 'confirmed'. */
  confidence: string;
}

export interface TwinInference {
  domain: string;
  key: string;
  value: unknown;
  confidence: string;
  reasoning: string;
}

export interface TwinContextSnapshot {
  trustTier: string;
  /** Preferences the user has expressed (or the twin has inferred + the user hasn't corrected). */
  preferences: TwinPreference[];
  /** Inferences the twin has drawn but hasn't yet promoted to preferences. */
  inferences: TwinInference[];
}

export interface TwinContextProvider {
  /** Return the user's twin profile in a renderer-friendly shape. */
  fetch(userId: string): Promise<TwinContextSnapshot>;
}

/**
 * Public shape returned by the memory context port. `summary` is the
 * one-line `situationSummary` from `EpisodicMemory`; `actionTaken` and
 * `outcome` are present when the episode was a real decision (vs. an
 * observation).
 */
export interface MemoryHit {
  summary: string;
  domain: string;
  actionTaken?: string;
  outcome?: string;
  /** ISO timestamp of when this episode happened. */
  occurredAt?: string;
  /**
   * The record's stable id from the memory backend — e.g. a gbrain page
   * reference or a mempalace episode id (each backend decides what the id
   * points at). Optional so older providers that predate source attribution
   * still satisfy the contract; when present it lets the assistant cite
   * *which* memory it consulted and anchors a future "view source" link.
   */
  id?: string;
  /**
   * Origin label of the record — the connector or surface it came from
   * (e.g. `gmail`, `calendar`, `decision`, `memory`). Used to render a
   * human-readable provenance hint next to the cited memory.
   */
  source?: string;
}

/**
 * A citable reference to a memory the assistant consulted when composing a
 * reply. Surfaced in `AssistantReply.metadata.sources` and rendered as a
 * "based on what I found" footer in the chat UI — the Explanation-First
 * promise applied to the conversational surface: the user can see *what
 * evidence the answer drew on*, not just the answer.
 *
 * This attributes the memories that were retrieved and fed to the model as
 * context for this turn. It does not (and cannot) claim the model quoted
 * each one verbatim — it's "here's what I looked at," which is the honest,
 * verifiable claim.
 */
export interface MemorySource {
  /** Stable id of the cited record from the memory backend (gbrain page reference or mempalace episode id). */
  id: string;
  /** Human-readable one-line label — the episode/page summary. */
  label: string;
  /** Origin of the memory (e.g. `gmail`, `calendar`, `decision`, `memory`). */
  source: string;
  /** Domain tag when known (`email` / `calendar` / `finance` / …). */
  domain?: string;
  /** ISO timestamp of when the episode occurred, when known. */
  occurredAt?: string;
}

export interface MemoryContextProvider {
  /** Return episodes relevant to a search query. Empty array when nothing relevant. */
  search(userId: string, query: string, limit?: number): Promise<MemoryHit[]>;
}

/**
 * Hard cap on the rendered context block. Sized so the rest of the prompt
 * (system instructions ~500 chars, conversation history up to ~10K chars)
 * still fits comfortably under common provider context limits.
 *
 * We measure in bytes, not characters, to keep the cap honest under
 * non-ASCII content (emoji, accented characters, CJK). A user with a
 * preference like "value: 寿司" should not silently overflow.
 */
export const MAX_CONTEXT_BYTES = 2_000;

/**
 * Confidence levels we consider strong enough to mention in context.
 *
 * Speculative inferences are noise — surfacing them as "I think you prefer X"
 * makes the assistant look unsure of itself and frequently wrong. We keep
 * them in the model (`@skytwin/twin-model`) but don't broadcast them.
 */
const SHOW_CONFIDENCES = new Set(['confirmed', 'high', 'moderate']);

/**
 * Maximum number of preferences and inferences to surface. The twin can
 * accumulate hundreds of preferences over time and dumping all of them
 * would (a) blow the byte cap and (b) make the model lose the signal.
 *
 * We keep the highest-confidence ones, ranked: confirmed > high > moderate.
 */
const MAX_PREFERENCES = 12;
const MAX_INFERENCES = 6;
const MAX_MEMORIES = 5;

/**
 * Max characters of a memory summary surfaced as a source label. Long
 * summaries get ellipsis-truncated so a citation chip stays one line and
 * the persisted `metadata.sources` blob stays small.
 */
const SOURCE_LABEL_MAX = 140;

const CONFIDENCE_RANK: Record<string, number> = {
  confirmed: 4,
  high: 3,
  moderate: 2,
  low: 1,
  speculative: 0,
};

/**
 * Stringify an unknown preference/inference value for the prompt. Booleans
 * become 'yes' / 'no' (more readable than 'true' / 'false'), strings pass
 * through, anything else gets JSON.stringified with a length cap so a
 * pathological deeply-nested object can't bloat one line past the byte cap.
 */
function renderValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value === null || value === undefined) return '—';
  try {
    const json = JSON.stringify(value);
    return json.length > 80 ? `${json.slice(0, 77)}…` : json;
  } catch {
    return '—';
  }
}

/**
 * Truncate a string to fit a byte budget. Cuts at codepoint boundaries
 * (TextEncoder ensures we don't slice mid-multi-byte-char). Adds an
 * ellipsis when truncation happens.
 */
function truncateToBytes(input: string, maxBytes: number): string {
  const enc = new TextEncoder();
  const bytes = enc.encode(input);
  if (bytes.length <= maxBytes) return input;
  // Reserve room for the ellipsis. '…' is U+2026, 3 UTF-8 bytes.
  const ELLIPSIS_BYTES = 3;
  const dec = new TextDecoder('utf-8', { fatal: false });
  let cut = maxBytes - ELLIPSIS_BYTES;
  // Walk back until we land on a valid UTF-8 boundary (no replacement
  // char at the end). Max 4 iterations because UTF-8 codepoints span
  // at most 4 bytes.
  for (let i = 0; i < 4; i++) {
    const decoded = dec.decode(bytes.slice(0, cut));
    if (!decoded.endsWith('�')) {
      return `${decoded}…`;
    }
    cut -= 1;
  }
  return `${dec.decode(bytes.slice(0, Math.max(0, cut)))}…`;
}

/**
 * Compose a context block from twin profile + relevant memories.
 *
 * Output shape (one example):
 *
 *   ## What I know about you
 *   Trust tier: moderate_autonomy
 *   Preferences:
 *   - email/auto_archive = yes (high)
 *   - calendar/default_meeting_length = 30 (confirmed)
 *   Inferences:
 *   - finance/monthly_subscription_threshold = 50 — based on 12 prior approvals
 *   ## Relevant past episodes
 *   - [2026-04-12] email · Archived a Stripe receipt without asking
 *   - [2026-03-30] calendar · Declined a recurring meeting after 3 conflicts
 *
 * Returns an empty string when both providers come up empty (no profile,
 * no memories) — the AssistantService treats that as "use the default
 * system prompt unchanged."
 */
export class ContextBuilder {
  constructor(
    private readonly twin: TwinContextProvider,
    private readonly memory: MemoryContextProvider | null = null,
  ) {}

  /**
   * Render the context block only. Kept for back-compat — callers that
   * don't need source attribution (and the existing unit tests) use this.
   * Delegates to `buildWithSources` and drops the sources.
   */
  async build(userId: string, query: string): Promise<string> {
    return (await this.buildWithSources(userId, query)).context;
  }

  /**
   * Render the context block AND return the memories it drew on as citable
   * `MemorySource[]`. The assistant attaches these to the reply metadata so
   * the chat UI can show "based on what I found" — the Explanation-First
   * promise on the conversational surface.
   *
   * Only memories carrying a stable `id` become sources: a citation the
   * user can't trace back to a record isn't a citation. Memories without an
   * id still contribute to the prompt context (they're rendered in the
   * block); they just aren't claimed as attributable sources.
   */
  async buildWithSources(
    userId: string,
    query: string,
  ): Promise<{ context: string; sources: MemorySource[] }> {
    // Fetch in parallel — twin profile and memory search are independent.
    // If either provider throws, log via console.warn (the AssistantService
    // catches rejections and falls back to no-context, but that's coarse;
    // partial context is better than no context).
    const [twinSnapshot, memories] = await Promise.all([
      this.fetchTwinSafe(userId),
      this.fetchMemoriesSafe(userId, query),
    ]);

    const sections: string[] = [];

    if (twinSnapshot) {
      const block = renderTwinBlock(twinSnapshot);
      if (block) sections.push(block);
    }
    if (memories.length > 0) {
      sections.push(renderMemoriesBlock(memories));
    }

    if (sections.length === 0) return { context: '', sources: [] };

    const context = truncateToBytes(sections.join('\n\n'), MAX_CONTEXT_BYTES);

    // Cite only memories whose rendered text actually survived truncation.
    // The memories block sits at the end of the composed context, so a
    // `MAX_CONTEXT_BYTES` cut drops its tail first; citing a memory the model
    // never received would over-claim the evidence behind the reply.
    const sources = memories
      .filter((m): m is MemoryHit & { id: string } => typeof m.id === 'string' && m.id.length > 0)
      .filter((m) => m.summary.length > 0 && context.includes(m.summary))
      .map(toMemorySource);

    return { context, sources };
  }

  private async fetchTwinSafe(userId: string): Promise<TwinContextSnapshot | null> {
    try {
      return await this.twin.fetch(userId);
    } catch (err) {
      console.warn(
        '[assistant.ContextBuilder] twin fetch failed, falling back to no twin context:',
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  private async fetchMemoriesSafe(userId: string, query: string): Promise<MemoryHit[]> {
    if (!this.memory) return [];
    try {
      return await this.memory.search(userId, query, MAX_MEMORIES);
    } catch (err) {
      console.warn(
        '[assistant.ContextBuilder] memory search failed, falling back to no memory context:',
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }
}

function renderTwinBlock(snap: TwinContextSnapshot): string {
  const lines: string[] = ['## What I know about you'];
  if (snap.trustTier) {
    lines.push(`Trust tier: ${snap.trustTier}`);
  }

  const prefs = filterAndRankConfidences(snap.preferences).slice(0, MAX_PREFERENCES);
  if (prefs.length > 0) {
    lines.push('Preferences:');
    for (const p of prefs) {
      lines.push(`- ${p.domain}/${p.key} = ${renderValue(p.value)} (${p.confidence})`);
    }
  }

  const infs = filterAndRankConfidences(snap.inferences).slice(0, MAX_INFERENCES);
  if (infs.length > 0) {
    lines.push('Inferences (not yet user-confirmed):');
    for (const i of infs) {
      const reason = i.reasoning ? ` — ${i.reasoning}` : '';
      lines.push(`- ${i.domain}/${i.key} = ${renderValue(i.value)} (${i.confidence})${reason}`);
    }
  }

  // If the trust tier was the only line, drop the section entirely — a
  // bare "Trust tier: observer" with no preferences or inferences is
  // noise to the model.
  if (lines.length <= 2) return '';
  return lines.join('\n');
}

/**
 * Project a retrieved `MemoryHit` (already known to carry an `id`) into a
 * citable `MemorySource`. `source` prefers the hit's origin label and falls
 * back to its domain (then a generic `memory`) so the chip never renders a
 * blank provenance.
 *
 * The label is normalized to a single clean line before the `SOURCE_LABEL_MAX`
 * ellipsis cap: the default gbrain backend stores raw page bodies (multi-line
 * email / web / file content) as the hit text, and a citation chip must read
 * as one legible line, not a wrapped body dump. `summary` is typed required,
 * but the package serves pluggable external providers, so a non-string value
 * coalesces to '' rather than throwing out of `buildWithSources`.
 */
function toMemorySource(hit: MemoryHit & { id: string }): MemorySource {
  const oneLine = (typeof hit.summary === 'string' ? hit.summary : '').replace(/\s+/g, ' ').trim();
  const label =
    oneLine.length > SOURCE_LABEL_MAX ? `${oneLine.slice(0, SOURCE_LABEL_MAX - 1)}…` : oneLine || 'A memory';
  return {
    id: hit.id,
    label,
    source: hit.source && hit.source.length > 0 ? hit.source : hit.domain || 'memory',
    ...(hit.domain ? { domain: hit.domain } : {}),
    ...(hit.occurredAt ? { occurredAt: hit.occurredAt } : {}),
  };
}

function renderMemoriesBlock(memories: MemoryHit[]): string {
  const lines: string[] = ['## Relevant past episodes'];
  for (const m of memories) {
    const date = m.occurredAt ? `[${m.occurredAt.slice(0, 10)}] ` : '';
    const action = m.actionTaken ? ` · ${m.actionTaken}` : '';
    const outcome = m.outcome ? ` (${m.outcome})` : '';
    lines.push(`- ${date}${m.domain} · ${m.summary}${action}${outcome}`);
  }
  return lines.join('\n');
}

/**
 * Filter to only display-worthy confidences, then rank highest-first so
 * the slice() to MAX_* keeps the most-load-bearing entries.
 */
function filterAndRankConfidences<T extends { confidence: string }>(items: T[]): T[] {
  return items
    .filter((it) => SHOW_CONFIDENCES.has(it.confidence))
    .slice() // copy before sort to avoid mutating caller's array
    .sort((a, b) => (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0));
}
