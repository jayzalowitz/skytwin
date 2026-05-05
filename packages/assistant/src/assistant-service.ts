import type { LlmClient, LlmStreamEvent } from '@skytwin/llm-client';
import type { ContextBuilder } from './context-builder.js';

/**
 * One turn in the conversation, in the order it was said. Mirrors the
 * shape of `assistant_messages` rows from `@skytwin/db` but without DB
 * concerns — this package stays pure so it can be unit-tested without a
 * database (or even with a stubbed LlmClient).
 *
 * Issue #135 phase 1.
 */
export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Result of one assistant generation. The metadata block is what the route
 * persists alongside the assistant message — useful for debugging "why was
 * this reply slow?" or "which provider answered?" without re-querying
 * provider logs.
 */
export interface AssistantReply {
  content: string;
  metadata: {
    provider: string;
    model: string;
    latencyMs: number;
  };
}

/**
 * The system prompt the assistant ships with by default. Phase 1 keeps this
 * minimal — no tool-use directives, no policy boundaries, no twin context.
 * Phase 2+ will compose this with twin-profile + memory-palace context.
 *
 * Worth pulling out as a named export so future `tweak the system prompt`
 * changes are diff-visible rather than buried in a service constructor.
 */
export const DEFAULT_ASSISTANT_SYSTEM_PROMPT = [
  'You are SkyTwin, a personal assistant integrated into the user’s SkyTwin dashboard.',
  'Reply concisely. If the user asks you to take an action that would change',
  'data outside this conversation (send mail, modify calendar, spend money),',
  'tell them you can only converse for now and link them to the relevant',
  'dashboard surface. Do not invent capabilities.',
].join(' ');

/**
 * Hard cap on conversation history fed back to the LLM. The cap exists for
 * three reasons:
 *   1. Cost — every prior turn pays for both prompt and completion tokens.
 *   2. Latency — bigger prompts are slower at the provider's first byte.
 *   3. Provider context-window limits — a 1000-message thread overflows
 *      every model we currently chain through.
 *
 * 20 turns is enough to keep the immediate-context coherent ("what did I
 * ask 5 minutes ago?") without bloating the prompt for hour-long threads.
 * Older turns are silently dropped — the user can still see them in the UI
 * because they're persisted, but the model doesn't see them.
 */
export const MAX_HISTORY_TURNS = 20;

/**
 * Legacy: format a chat history into a single-string prompt with
 * `User:` / `Assistant:` role labels. Issue #149 closed the multi-turn
 * `LlmClient` API gap, so the assistant no longer uses this helper —
 * `reply()` and `replyStream()` now pass the `ChatTurn[]` directly to
 * `LlmClient.generate` / `generateStream` as a `ChatMessage[]`.
 *
 * Kept exported for back-compat: external callers (none known in-tree)
 * and tests that exercised the flattening behavior. Plan to remove on
 * the next major bump if no consumers surface.
 */
export function formatHistoryAsPrompt(history: ChatTurn[]): string {
  return history
    .map((turn) => {
      if (turn.role === 'system') return turn.content;
      const label = turn.role === 'user' ? 'User' : 'Assistant';
      return `${label}: ${turn.content}`;
    })
    .concat('Assistant:')
    .join('\n\n');
}

/**
 * Optional per-request enrichment context. When supplied, `AssistantService`
 * asks the `ContextBuilder` for a renderable block of twin profile +
 * relevant memories and prepends it to the system prompt. Issue #147
 * (phase 2b).
 *
 * Backward-compatible: omitting this on a `reply()` call falls back to
 * the bare default system prompt — same behavior as phase 1.
 */
export interface EnrichmentRequest {
  userId: string;
  /**
   * Free-text query used to retrieve relevant episodic memories. Typically
   * the latest user message — that's what the assistant is about to
   * answer, so the most-relevant memories are the ones that match it.
   */
  query: string;
}

/**
 * Stateless service that turns a chat history into the next assistant
 * reply. Persistence (which thread? which message ids?) is the route
 * layer's responsibility — this service does not touch the DB.
 *
 * Issue #135 phase 1: text-only chat completion.
 * Issue #147 phase 2b: optional twin/memory enrichment in the system prompt.
 * Issue #146 phase 2a: SSE streaming via `replyStream`.
 * Issue #149 phase 3: multi-turn `LlmClient` API — `reply()` and
 *   `replyStream()` now pass `ChatTurn[]` directly as `ChatMessage[]`,
 *   dropping the `User:` / `Assistant:` flattening workaround.
 *
 * Still deferred:
 *   - action-intent routing through @skytwin/decision-engine — #148
 */
export class AssistantService {
  constructor(
    private readonly llm: LlmClient,
    private readonly systemPrompt: string = DEFAULT_ASSISTANT_SYSTEM_PROMPT,
    /**
     * Optional context builder. When provided AND a `reply()` call passes
     * `enrichment`, the rendered twin/memory context is prepended to the
     * system prompt for that request. Omit at construction time for
     * tests, early bring-up, or routes that don't have a userId.
     */
    private readonly contextBuilder: ContextBuilder | null = null,
  ) {}

  /**
   * Build the system prompt for one request: the default (or
   * constructor-supplied) system prompt, optionally prepended with the
   * `ContextBuilder` output when `enrichment` is supplied. Shared between
   * `reply()` and `replyStream()` so they cannot drift on the
   * compose-the-prompt step.
   */
  private async composeSystemPrompt(enrichment?: EnrichmentRequest): Promise<string> {
    if (!enrichment || !this.contextBuilder) return this.systemPrompt;
    const context = await this.contextBuilder.build(enrichment.userId, enrichment.query);
    if (!context) return this.systemPrompt;
    return `${context}\n\n${this.systemPrompt}`;
  }

  /**
   * Reply to the latest user message in `history`.
   *
   * `history` should include the user's just-sent message as its last
   * entry. Returns the assistant's reply text plus generation metadata
   * for the route to persist.
   *
   * `enrichment` is optional: when supplied AND a `ContextBuilder` was
   * passed at construction, the builder runs and the rendered context
   * gets prepended to the system prompt. When either is missing the
   * service uses the bare default system prompt — same behavior as
   * phase 1, no surprises for routes that haven't opted in.
   *
   * Throws `AllProvidersFailedError` from `@skytwin/llm-client` when
   * every configured provider fails (or has an open circuit). The route
   * should catch that and respond 502 — phase 1 doesn't try to recover
   * gracefully because there's no fallback content worth showing.
   */
  async reply(history: ChatTurn[], enrichment?: EnrichmentRequest): Promise<AssistantReply> {
    const trimmed = history.slice(-MAX_HISTORY_TURNS);
    const systemPrompt = await this.composeSystemPrompt(enrichment);

    // Issue #149: pass the trimmed history directly as a ChatMessage[]
    // — providers handle multi-turn natively now. The role-flattening
    // workaround in `formatHistoryAsPrompt` is no longer in this path.
    const response = await this.llm.generate(trimmed, {
      systemPrompt,
      // Conservative defaults — phase 1 is text-only, no need for long
      // outputs. Tunable per-request once the route exposes options.
      temperature: 0.7,
      maxTokens: 800,
    });

    return {
      content: response.content,
      metadata: {
        provider: response.provider,
        model: response.model,
        latencyMs: response.latencyMs,
      },
    };
  }

  /**
   * Streaming variant of `reply()`. Issue #146 (phase 2a).
   *
   * Yields `{ type: 'chunk' }` events with partial text as it arrives,
   * then exactly one terminal event:
   *
   *   - `{ type: 'done' }` with the assembled `fullContent` + metadata
   *     when generation completes successfully.
   *   - `{ type: 'error' }` with the assembled-so-far partial content +
   *     the error reason when generation fails mid-stream (after at least
   *     one chunk has been yielded). The route surfaces this as an SSE
   *     `error` event so the UI can show the partial reply with a caveat.
   *
   * Pre-first-chunk failures throw `AllProvidersFailedError` from the
   * underlying `LlmClient.generateStream`; the caller catches and turns
   * those into HTTP 502 — same as the sync path.
   *
   * Same enrichment semantics as `reply()`: when `enrichment` is supplied
   * AND a `ContextBuilder` is wired, the rendered context block is
   * prepended to the system prompt for this request.
   */
  async *replyStream(
    history: ChatTurn[],
    enrichment?: EnrichmentRequest,
  ): AsyncIterable<AssistantStreamEvent> {
    const trimmed = history.slice(-MAX_HISTORY_TURNS);
    const systemPrompt = await this.composeSystemPrompt(enrichment);

    const collected: string[] = [];
    try {
      // Issue #149: pass the trimmed history directly as a ChatMessage[].
      for await (const event of this.llm.generateStream(trimmed, {
        systemPrompt,
        temperature: 0.7,
        maxTokens: 800,
      })) {
        if (event.type === 'chunk') {
          collected.push(event.content);
          yield { type: 'chunk', content: event.content };
        } else if (event.type === 'done') {
          // Use the chain's authoritative `content` (it joined the chunks
          // itself) over our `collected` — same value but avoids any
          // possibility of drift if a future chunk filter trims something.
          yield {
            type: 'done',
            fullContent: event.content,
            metadata: {
              provider: event.provider,
              model: event.model,
              latencyMs: event.latencyMs,
            },
          };
          return;
        }
      }
    } catch (err) {
      // Pre-first-chunk failures (e.g. AllProvidersFailedError when no
      // provider can be reached at all) re-throw — the caller turns those
      // into HTTP 502, same as the sync `reply()` path.
      //
      // Mid-stream failures after at least one chunk landed yield a
      // terminal error event so the route can flush a partial-reply
      // notification to the client.
      if (collected.length === 0) {
        throw err;
      }
      yield {
        type: 'error',
        partialContent: collected.join(''),
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Events yielded by `AssistantService.replyStream`. Distinct from
 * `LlmStreamEvent` so the assistant can shape its own protocol (different
 * field names — `fullContent` and `partialContent` — make the
 * SSE-on-the-wire side easier to consume on the web client).
 *
 * Re-exporting `LlmStreamEvent` would couple downstream callers to the
 * provider-level chunk shape, which is more constrained than what the
 * assistant promises (e.g. error events with partial content are an
 * assistant-level concept, not a provider concept).
 */
export type AssistantStreamEvent =
  | { type: 'chunk'; content: string }
  | {
      type: 'done';
      fullContent: string;
      metadata: { provider: string; model: string; latencyMs: number };
    }
  | { type: 'error'; partialContent: string; message: string };

// Re-export for convenience so a route that imports AssistantService
// doesn't also need to import from @skytwin/llm-client just for the
// underlying event shape (when it cares about that level of detail).
export type { LlmStreamEvent };
