import type { LlmClient } from '@skytwin/llm-client';

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
 * Stateless service that turns a chat history into the next assistant
 * reply. Persistence (which thread? which message ids?) is the route
 * layer's responsibility — this service does not touch the DB.
 *
 * Issue #135 phase 1: text-only chat completion. Phase 2 wires:
 *   - SSE streaming (this method becomes an `AsyncIterable<string>`)
 *   - twin-profile + memory-palace context enrichment
 *   - action-intent routing through @skytwin/decision-engine
 */
export class AssistantService {
  constructor(
    private readonly llm: LlmClient,
    private readonly systemPrompt: string = DEFAULT_ASSISTANT_SYSTEM_PROMPT,
  ) {}

  /**
   * Reply to the latest user message in `history`.
   *
   * `history` should include the user's just-sent message as its last
   * entry. Returns the assistant's reply text plus generation metadata
   * for the route to persist.
   *
   * Throws `AllProvidersFailedError` from `@skytwin/llm-client` when
   * every configured provider fails (or has an open circuit). The route
   * should catch that and respond 502 — phase 1 doesn't try to recover
   * gracefully because there's no fallback content worth showing.
   */
  async reply(history: ChatTurn[]): Promise<AssistantReply> {
    const trimmed = history.slice(-MAX_HISTORY_TURNS);
    const prompt = formatHistoryAsPrompt(trimmed);

    const response = await this.llm.generate(prompt, {
      systemPrompt: this.systemPrompt,
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
