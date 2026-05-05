import type { LlmClient } from '@skytwin/llm-client';
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
 * Format a chat history into the single-prompt shape that `LlmClient`
 * accepts today. We label each turn with its role (`User:` / `Assistant:`)
 * so the model can follow the conversation; this is a workaround for the
 * fact that `LlmClient.generate` takes a single string rather than a
 * messages array.
 *
 * Phase 2 will refactor `LlmClient` to accept multi-turn message arrays
 * natively — at which point this function becomes obsolete and we can
 * remove the role-prefix workaround. Marked here so the call site is
 * easy to find when that refactor lands.
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
 * Issue #147 phase 2b: optional twin/memory enrichment in the system
 * prompt (this commit).
 *
 * Still deferred:
 *   - SSE streaming (this method becomes an `AsyncIterable<string>`) — #146
 *   - action-intent routing through @skytwin/decision-engine — #148
 *   - native multi-turn LlmClient API — #149
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
    const prompt = formatHistoryAsPrompt(trimmed);

    let systemPrompt = this.systemPrompt;
    if (enrichment && this.contextBuilder) {
      const context = await this.contextBuilder.build(enrichment.userId, enrichment.query);
      if (context) {
        systemPrompt = `${context}\n\n${this.systemPrompt}`;
      }
    }

    const response = await this.llm.generate(prompt, {
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
}
