/**
 * @skytwin/assistant — ChatGPT-style conversational assistant. Issue #135.
 *
 * Phase 1: stateless service that wraps `@skytwin/llm-client` for text-only
 * chat completion. Persistence lives in `@skytwin/db.assistantRepository`;
 * routing lives in `apps/api/src/routes/assistant.ts`. This package is
 * deliberately small — it stays free of DB and HTTP concerns so the LLM
 * interaction can be unit-tested with a stub `LlmClient`.
 *
 * Phase 2+ will add SSE streaming, twin/memory context enrichment, and
 * action-intent routing through `@skytwin/decision-engine`.
 */
export {
  AssistantService,
  formatHistoryAsPrompt,
  DEFAULT_ASSISTANT_SYSTEM_PROMPT,
  MAX_HISTORY_TURNS,
} from './assistant-service.js';
export type {
  ChatTurn,
  AssistantReply,
  EnrichmentRequest,
  AssistantStreamEvent,
  LlmStreamEvent,
} from './assistant-service.js';

export { ContextBuilder, MAX_CONTEXT_BYTES } from './context-builder.js';
export type {
  TwinContextProvider,
  TwinContextSnapshot,
  TwinPreference,
  TwinInference,
  MemoryContextProvider,
  MemoryHit,
  MemorySource,
} from './context-builder.js';

export { detectIntent } from './intent-classifier.js';
export type { ActionIntent } from './intent-classifier.js';
export type { ActionRouter, ActionRouteOutcome } from './action-router.js';
